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
export class FakeLockService extends EventEmitter {
  private readonly locked = new Set<string>();
  private readonly fenceCounters = new Map<string, number>();
  private readonly calls: FakeLockCall[] = [];

  constructor() {
    super();
    // Lets @Lock()-decorated methods resolve a service without LockModule.
    setActiveLockService(this as unknown as LockService);
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

  /** Every `withLock`/`tryLock`/`tryLockWithToken` call made so far, in order. */
  getCalls(): ReadonlyArray<FakeLockCall> {
    return this.calls;
  }

  /** Clears the call log recorded by {@link getCalls} — does not affect simulated locks. */
  clearCalls(): void {
    this.calls.length = 0;
  }

  /**
   * Runs the callback immediately, unless `resource` (or, for a lock group,
   * any member of it) is currently {@link simulateLocked} — in which case it
   * throws `LockAcquisitionException`, exactly as the real `withLock` does
   * on contention.
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

    const resources = Array.isArray(resource) ? resource : [resource];
    const blocked = resources.find((r) => this.locked.has(r));
    if (blocked !== undefined) {
      throw new LockAcquisitionException(blocked, 0, 0);
    }

    const label = Array.isArray(resource) ? [...resource].sort().join(',') : resource;
    return callback(new AbortController().signal, this.nextFencingToken(label));
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
}
