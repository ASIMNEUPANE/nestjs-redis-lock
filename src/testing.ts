import { EventEmitter } from 'events';
import { Injectable } from '@nestjs/common';
import type { Lock } from 'redlock';
import type { LockService } from './lock.service';
import type { LockCallOptions } from './interfaces/lock-call-options';
import type { FencingToken } from './interfaces/fencing-token';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
import { setActiveLockService } from './lock.holder';

/** One recorded `withLock`/`tryLock` invocation — see {@link FakeLockService.getCalls}. */
export interface FakeLockCall {
  method: 'withLock' | 'tryLock' | 'tryLockWithToken';
  resource: string | string[];
  options?: LockCallOptions;
  at: number;
}

/** In-process admission state backing `queue: true` / `maxConcurrent` simulation. */
interface FakeSemaphore {
  count: number;
  max: number;
  waiters: Array<() => void>;
}

/** In-process admission state backing `mode: 'read' | 'write'` simulation. */
interface FakeRwWaiter {
  mode: 'read' | 'write';
  grant: () => void;
}
interface FakeRwState {
  readers: number;
  writerActive: boolean;
  queue: FakeRwWaiter[];
}

const FINGERPRINT = 'fake-lock-service';

/**
 * Drop-in replacement for LockService in unit tests.
 *
 * By default, runs callbacks immediately without acquiring any Redis locks.
 * Call {@link simulateLocked} to make a specific resource behave as if it
 * were held by someone else — every mode (`withLock`, `tryLock`,
 * `tryLockWithToken`) then fails exactly as the real service would,
 * including for a lock group where any one member is simulated-locked. This
 * is what makes a test double useful for exercising `onFail: 'throw'` /
 * `onFail: 'skip'` branches, not just the happy path.
 *
 * `queue: true`, `maxConcurrent`, and `mode: 'read' | 'write'` are also
 * simulated — in-process admission bookkeeping, not a timing-faithful
 * reimplementation of the real Redis/Lua mechanics — so a test can assert
 * an admission bound, read/write exclusion, or FIFO-ish hand-off without
 * needing Redis. `queueTimeout` is intentionally ignored (documented, not
 * half-built): the fake has no wall-clock model, so it never times a caller
 * out of the queue.
 *
 * Constructing it also registers it as the active lock service, so methods
 * decorated with `@Lock()` work in unit tests without a Redis connection.
 *
 * @example
 * // In your test module:
 * await Test.createTestingModule({
 *   providers: [
 *     MyService,
 *     { provide: LockService, useClass: FakeLockService },
 *   ],
 * }).compile();
 *
 * @example
 * // Simulating contention
 * const fake = new FakeLockService();
 * fake.simulateLocked('seat:A1');
 * await expect(fake.withLock('seat:A1', async () => 'booked')).rejects.toThrow();
 */
@Injectable()
export class FakeLockService
  extends EventEmitter
  implements Pick<LockService, 'withLock' | 'tryLock' | 'tryLockWithToken' | 'extend' | 'isLocked'>
{
  private readonly locked = new Set<string>();
  private readonly fenceCounters = new Map<string, number>();
  private readonly calls: FakeLockCall[] = [];
  private readonly semaphores = new Map<string, FakeSemaphore>();
  private readonly rw = new Map<string, FakeRwState>();
  private readonly activeControllers = new Map<string, Set<AbortController>>();

  constructor() {
    super();
    // Lets @Lock()-decorated methods resolve a service without LockModule.
    // A constant fingerprint means constructing more of these across
    // beforeEach blocks never trips the holder's divergent-config warning.
    setActiveLockService(this as unknown as LockService, FINGERPRINT);
  }

  /** Makes `resource` behave as if it were held by another caller. */
  simulateLocked(resource: string): void {
    this.locked.add(resource);
  }

  /** Reverses {@link simulateLocked} for a single resource. */
  simulateUnlocked(resource: string): void {
    this.locked.delete(resource);
  }

  /** Reverses {@link simulateLocked} for every resource. */
  simulateAllUnlocked(): void {
    this.locked.clear();
  }

  /**
   * Aborts the signal of every currently in-flight `withLock` callback for
   * `resource`, simulating the lock being lost mid-callback. Fires
   * regardless of whether that call passed `autoExtend: true` — unlike the
   * real service, where only an auto-extend failure ever triggers this, this
   * is a deliberate test hook you call directly.
   *
   * @example
   * const fake = new FakeLockService();
   * const done = fake.withLock('job:1', async (signal) => {
   *   await waitUntilAborted(signal);
   * }, { autoExtend: true });
   * fake.simulateLockLoss('job:1');
   * await done; // the callback's signal is now aborted
   */
  simulateLockLoss(resource: string): void {
    const controllers = this.activeControllers.get(resource);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(new Error(`Simulated lock loss for "${resource}"`));
    }
  }

  /**
   * Clears simulated queue/semaphore/read-write admission state for
   * `resource`, or for every resource if omitted — useful for discarding
   * bookkeeping left behind by an abandoned holder (e.g. a leaked promise
   * from an earlier test) so a *later* acquisition isn't blocked by it. Does
   * not resolve or reject any call already waiting on the old state, and
   * does not affect {@link simulateLocked} state or the call log.
   */
  resetQueueState(resource?: string): void {
    if (resource === undefined) {
      this.semaphores.clear();
      this.rw.clear();
      return;
    }
    this.semaphores.delete(resource);
    this.rw.delete(resource);
  }

  /** Every `withLock`/`tryLock`/`tryLockWithToken` call made so far, in order. */
  getCalls(): ReadonlyArray<FakeLockCall> {
    return this.calls;
  }

  /** Clears the call log recorded by {@link getCalls} — does not affect simulated locks. */
  clearCalls(): void {
    this.calls.length = 0;
  }

  /**
   * Runs the callback once admitted, unless `resource` (or, for a lock
   * group, any member of it) is currently {@link simulateLocked} — in which
   * case it throws `LockAcquisitionException`, exactly as the real
   * `withLock` does on contention. `queue`/`maxConcurrent`/`mode` gate
   * admission the same way the real service's option combinations do
   * (including rejecting the same invalid combinations), but via in-process
   * bookkeeping rather than Redis.
   *
   * @example
   * const result = await fakeLockService.withLock('res', async () => 'value');
   * // result === 'value'
   */
  async withLock<T>(
    resource: string | string[],
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    durationOrOptions?: number | LockCallOptions,
    autoExtend?: boolean,
    queue?: boolean,
  ): Promise<T> {
    const options: LockCallOptions =
      typeof durationOrOptions === 'object' && durationOrOptions !== null
        ? durationOrOptions
        : { duration: durationOrOptions, autoExtend, queue };
    this.calls.push({ method: 'withLock', resource, options, at: Date.now() });

    if (Array.isArray(resource)) {
      if (options.queue) {
        throw new Error(
          'queue: true is not supported for lock groups (array resources). ' +
            'Queue a single coordinating resource instead, or drop the queue option ' +
            `for [${resource.join(', ')}].`,
        );
      }
      if (options.maxConcurrent !== undefined) {
        throw new Error(
          'maxConcurrent is not supported for lock groups (array resources). ' +
            'Use a single coordinating resource for the semaphore instead, or drop ' +
            `maxConcurrent for [${resource.join(', ')}].`,
        );
      }
      if (options.mode !== undefined) {
        throw new Error(
          'mode (read/write) is not supported for lock groups (array resources). ' +
            'Use a single coordinating resource for the read-write lock instead, or drop ' +
            `mode for [${resource.join(', ')}].`,
        );
      }
    }

    if (options.mode !== undefined && (options.queue || options.maxConcurrent !== undefined)) {
      throw new Error(
        `mode cannot be combined with queue or maxConcurrent for "${String(resource)}". ` +
          'A read-write lock already provides its own admission and ordering.',
      );
    }

    if (options.queue && options.maxConcurrent !== undefined) {
      throw new Error(
        `queue and maxConcurrent cannot be combined for "${String(resource)}". ` +
          'maxConcurrent already provides FIFO-ordered admission — drop queue: true.',
      );
    }

    if (
      options.maxConcurrent !== undefined &&
      (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1)
    ) {
      throw new Error(
        `maxConcurrent must be a positive integer, got ${String(options.maxConcurrent)} for "${String(resource)}".`,
      );
    }

    const resources = Array.isArray(resource) ? resource : [resource];
    const blocked = resources.find((r) => this.locked.has(r));
    if (blocked !== undefined) {
      throw new LockAcquisitionException(blocked, 0, 0);
    }

    const label = Array.isArray(resource) ? [...resource].sort().join(',') : resource;

    let release: (() => void) | undefined;
    if (!Array.isArray(resource) && options.mode !== undefined) {
      release = await this.acquireRw(label, options.mode);
    } else if (!Array.isArray(resource) && (options.queue || options.maxConcurrent !== undefined)) {
      release = await this.acquireSlot(label, options.maxConcurrent ?? 1);
    }

    const controller = new AbortController();
    this.trackController(label, controller);
    try {
      return await callback(controller.signal, this.nextFencingToken(label));
    } finally {
      this.untrackController(label, controller);
      release?.();
    }
  }

  /**
   * Returns a fake `Lock` unless `resource` is currently {@link simulateLocked},
   * in which case it returns null — matching the real `tryLock`'s contract.
   *
   * @example
   * const lock = await fakeLockService.tryLock('res');
   * // lock === null only if simulateLocked('res') was called
   */
  async tryLock(resource: string, _duration?: number): Promise<Lock | null> {
    this.calls.push({ method: 'tryLock', resource, at: Date.now() });

    if (this.locked.has(resource)) {
      return null;
    }
    return this.fakeLock(resource);
  }

  /**
   * Like {@link tryLock}, but also returns a {@link FencingToken}.
   *
   * @example
   * const acquired = await fakeLockService.tryLockWithToken('res');
   * // acquired === { lock, fencingToken: 1 } the first time, null if simulated-locked
   */
  async tryLockWithToken(
    resource: string,
    _duration?: number,
  ): Promise<{ lock: Lock; fencingToken: FencingToken } | null> {
    this.calls.push({ method: 'tryLockWithToken', resource, at: Date.now() });

    if (this.locked.has(resource)) {
      return null;
    }
    return { lock: this.fakeLock(resource), fencingToken: this.nextFencingToken(resource) };
  }

  /**
   * Returns the same lock unchanged.
   *
   * @example
   * const extended = await fakeLockService.extend(lock, 5000);
   * // extended === lock
   */
  async extend(lock: Lock, _duration: number): Promise<Lock> {
    return lock;
  }

  /**
   * Reflects {@link simulateLocked} instead of always returning false.
   *
   * @example
   * const locked = await fakeLockService.isLocked('res');
   * // locked === false, or true after simulateLocked('res')
   */
  async isLocked(resource: string): Promise<boolean> {
    return this.locked.has(resource);
  }

  private nextFencingToken(label: string): FencingToken {
    const next = (this.fenceCounters.get(label) ?? 0) + 1;
    this.fenceCounters.set(label, next);
    return next;
  }

  private fakeLock(resource: string): Lock {
    return {
      resources: [resource],
      value: 'fake',
      attempts: [],
      expiration: Date.now() + 60_000,
      release: async () => undefined,
      extend: async () => this.fakeLock(resource),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Lock;
  }

  private trackController(label: string, controller: AbortController): void {
    const set = this.activeControllers.get(label);
    if (set) {
      set.add(controller);
    } else {
      this.activeControllers.set(label, new Set([controller]));
    }
  }

  private untrackController(label: string, controller: AbortController): void {
    const set = this.activeControllers.get(label);
    if (!set) {
      return;
    }
    set.delete(controller);
    if (set.size === 0) {
      this.activeControllers.delete(label);
    }
  }

  /**
   * FIFO counting-semaphore admission (`queue: true` is `max === 1`). Slots
   * are handed directly to the oldest waiter on release rather than
   * decrement-then-let-everyone-race, preserving FIFO order the same way
   * the real semaphore's ticket queue does.
   */
  private acquireSlot(key: string, max: number): Promise<() => void> {
    let sem = this.semaphores.get(key);
    if (!sem) {
      sem = { count: 0, max, waiters: [] };
      this.semaphores.set(key, sem);
    }
    sem.max = max;

    if (sem.count < sem.max) {
      sem.count++;
      return Promise.resolve(() => this.releaseSlot(key));
    }

    return new Promise<() => void>((resolve) => {
      sem!.waiters.push(() => resolve(() => this.releaseSlot(key)));
    });
  }

  private releaseSlot(key: string): void {
    const sem = this.semaphores.get(key);
    if (!sem) {
      return;
    }
    const nextWaiter = sem.waiters.shift();
    if (nextWaiter) {
      // Hand the freed slot directly to the oldest waiter — count is
      // neither decremented nor re-incremented, it's transferred.
      nextWaiter();
    } else {
      sem.count--;
    }
  }

  /**
   * Read/write admission via one FIFO queue shared by both modes. Because
   * every request — read or write — is only ever granted from the front of
   * this queue, a write request enqueued behind some reads naturally stops
   * further reads from jumping ahead of it once it reaches the front,
   * mirroring the real read-write lock's starvation guard without needing a
   * separate "writer waiting" flag.
   */
  private acquireRw(key: string, mode: 'read' | 'write'): Promise<() => void> {
    let rw = this.rw.get(key);
    if (!rw) {
      rw = { readers: 0, writerActive: false, queue: [] };
      this.rw.set(key, rw);
    }
    return new Promise<() => void>((resolve) => {
      rw!.queue.push({ mode, grant: () => resolve(() => this.releaseRw(key, mode)) });
      this.pumpRw(key);
    });
  }

  private releaseRw(key: string, mode: 'read' | 'write'): void {
    const rw = this.rw.get(key);
    if (!rw) {
      return;
    }
    if (mode === 'read') {
      rw.readers = Math.max(0, rw.readers - 1);
    } else {
      rw.writerActive = false;
    }
    this.pumpRw(key);
  }

  private pumpRw(key: string): void {
    const rw = this.rw.get(key);
    if (!rw) {
      return;
    }
    for (;;) {
      const front = rw.queue[0];
      if (!front) {
        return;
      }
      if (front.mode === 'read') {
        if (rw.writerActive) {
          return;
        }
        rw.queue.shift();
        rw.readers++;
        front.grant();
        continue;
      }
      if (rw.writerActive || rw.readers > 0) {
        return;
      }
      rw.queue.shift();
      rw.writerActive = true;
      front.grant();
      return;
    }
  }
}
