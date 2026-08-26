import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import Redlock, { Lock, ExecutionError, ResourceLockedError } from 'redlock';
import { LOCK_MODULE_OPTIONS } from './constants';
import { LockModuleOptions } from './interfaces/lock-module-options';
import { LockCallOptions } from './interfaces/lock-call-options';
import { FencingToken } from './interfaces/fencing-token';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
import { LockExtendException } from './exceptions/lock-extend.exception';
import { LockEvent, LockEventPayloads } from './lock.events';
import {
  setActiveLockService,
  clearActiveLockService,
  computeConfigFingerprint,
} from './lock.holder';

/** Error substrings that mean "Redis is unreachable", not "resource is held". */
const CONNECTION_ERROR_PATTERNS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'Connection is closed',
  'Stream isn’t writeable',
  "Stream isn't writeable",
  'Connection is already closed',
  'enableOfflineQueue',
];

/**
 * Admits up to `maxConcurrent` holders atomically. `KEYS[1]` is the owners
 * ZSET (member = holder UUID, score = expiry ms); `ARGV` is
 * `[now, expiry, maxConcurrent, member]`. Expired members are swept before
 * counting so a crashed holder's slot is reclaimed without a separate sweep.
 */
const SEMAPHORE_ACQUIRE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  return 1
end
return 0
`;

/**
 * Renews a semaphore holder's expiry only if it is still present — evicted
 * (TTL swept) is reported as failure so the caller treats the slot as lost
 * rather than silently re-registering. `KEYS[1]` is the owners ZSET;
 * `ARGV` is `[member, newExpiry]`.
 */
const SEMAPHORE_EXTEND_LUA = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0
`;

/** The subset of ioredis's scripting API the semaphore's Lua commands need. */
interface SemaphoreClient {
  semaphoreAcquire(
    ownersKey: string,
    now: number,
    expiry: number,
    maxConcurrent: number,
    member: string,
  ): Promise<number>;
  semaphoreExtend(ownersKey: string, member: string, newExpiry: number): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineCommand?: (name: string, definition: { numberOfKeys: number; lua: string }) => any;
  zrem(key: string, member: string): Promise<number>;
}

/**
 * A semaphore slot held in a Redis ZSET (`{key}:sem`), where each holder is
 * its own uniquely-named member. Release is `ZREM <own member>` — never a
 * shared counter — so N concurrent releases can never race or
 * double-decrement anything; `ZCARD` on the set always reflects the true
 * live count.
 */
class SemaphoreHandle implements InternalLockHandle {
  readonly resources: string[];

  constructor(
    private readonly client: SemaphoreClient,
    private readonly ownersKey: string,
    private readonly member: string,
  ) {
    this.resources = [ownersKey];
  }

  async extend(ttl: number): Promise<void> {
    const renewed = await this.client.semaphoreExtend(
      this.ownersKey,
      this.member,
      Date.now() + ttl,
    );
    if (renewed !== 1) {
      throw new Error(
        `Semaphore slot for "${this.ownersKey}" was evicted before it could be extended`,
      );
    }
  }

  async release(): Promise<void> {
    await this.client.zrem(this.ownersKey, this.member);
  }
}

/**
 * Admits a reader unless a writer currently holds the lock or is next in
 * line. `KEYS` are `[readers, writer, writerWaiting]`; `ARGV` is
 * `[now, expiry, member]`. Checking `writerWaiting` (not just `writer`) is
 * the starvation guard: without it, a steady stream of readers could keep a
 * waiting writer blocked indefinitely.
 */
const RW_ACQUIRE_READ_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
return 1
`;

/**
 * Admits a writer only once no readers remain and no other writer holds the
 * lock. `KEYS` are `[readers, writer]`; `ARGV` is `[now, ttlMs, member]`.
 * Only ever called by the head of the writer ticket queue, so "someone else
 * holds `writer`" should not happen in practice — checked anyway since a
 * Lua script is cheap insurance against a logic error elsewhere.
 */
const RW_ACQUIRE_WRITE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) > 0 then
  return 0
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[2])
return 1
`;

/**
 * Renews the writer key's TTL only if it still holds our member — a
 * compare-and-refresh, not a blind `PEXPIRE`, so an already-evicted writer
 * can't accidentally extend whatever new holder (a later writer) exists by
 * the time this runs. `KEYS[1]` is the writer key; `ARGV` is `[member, ttlMs]`.
 */
const RW_EXTEND_WRITE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/**
 * Deletes the writer key only if it still holds our member — a
 * compare-and-delete release, for the same reason the extend above is a
 * compare-and-refresh. `KEYS[1]` is the writer key; `ARGV` is `[member]`.
 */
const RW_RELEASE_WRITE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/** The subset of ioredis's scripting API the read-write lock's Lua commands need. */
interface ReadWriteClient {
  rwAcquireRead(
    readersKey: string,
    writerKey: string,
    writerWaitingKey: string,
    now: number,
    expiry: number,
    member: string,
  ): Promise<number>;
  rwAcquireWrite(
    readersKey: string,
    writerKey: string,
    now: number,
    ttlMs: number,
    member: string,
  ): Promise<number>;
  rwExtendWrite(writerKey: string, member: string, ttlMs: number): Promise<number>;
  rwReleaseWrite(writerKey: string, member: string): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineCommand?: (name: string, definition: { numberOfKeys: number; lua: string }) => any;
}

/**
 * A reader slot held in the same shape as a semaphore slot (an unbounded
 * ZSET of uniquely-named members) — reusing `semaphoreExtend`/`zrem` since
 * "renew this member's score if present" / "remove this member" are
 * identical operations regardless of which ZSET they act on.
 */
class RwReadHandle implements InternalLockHandle {
  readonly resources: string[];

  constructor(
    private readonly client: SemaphoreClient,
    private readonly readersKey: string,
    private readonly member: string,
  ) {
    this.resources = [readersKey];
  }

  async extend(ttl: number): Promise<void> {
    const renewed = await this.client.semaphoreExtend(
      this.readersKey,
      this.member,
      Date.now() + ttl,
    );
    if (renewed !== 1) {
      throw new Error(
        `Read lock slot for "${this.readersKey}" was evicted before it could be extended`,
      );
    }
  }

  async release(): Promise<void> {
    await this.client.zrem(this.readersKey, this.member);
  }
}

/**
 * The single writer, held as a plain Redis key rather than a ZSET member —
 * there is only ever one, so a compare-and-swap on a single value is
 * simpler than a one-member set.
 */
class RwWriteHandle implements InternalLockHandle {
  readonly resources: string[];

  constructor(
    private readonly client: ReadWriteClient,
    private readonly writerKey: string,
    private readonly member: string,
  ) {
    this.resources = [writerKey];
  }

  async extend(ttl: number): Promise<void> {
    const renewed = await this.client.rwExtendWrite(this.writerKey, this.member, ttl);
    if (renewed !== 1) {
      throw new Error(`Write lock for "${this.writerKey}" was evicted before it could be extended`);
    }
  }

  async release(): Promise<void> {
    await this.client.rwReleaseWrite(this.writerKey, this.member);
  }
}

/**
 * The acquire → extend → release contract every locking mode (mutex, group,
 * queue, semaphore, read-write) implements so they can all share one
 * runtime core (`runWithLock`). A redlock `Lock` is wrapped in a
 * `RedlockHandle` adapter; other modes wrap their own Redis state behind
 * the same three operations.
 */
interface InternalLockHandle {
  readonly resources: string[];
  /** Throws if the underlying hold could not be renewed — treated as loss. */
  extend(ttl: number): Promise<void>;
  release(): Promise<void>;
}

/** Adapts a redlock `Lock` — whose `.extend()` returns a new immutable
 * instance — to the mutable `InternalLockHandle` contract. */
class RedlockHandle implements InternalLockHandle {
  constructor(
    private lock: Lock,
    readonly resources: string[],
  ) {}

  async extend(ttl: number): Promise<void> {
    this.lock = await this.lock.extend(ttl);
  }

  async release(): Promise<void> {
    await this.lock.release();
  }
}

/**
 * Core distributed locking service. Wraps the redlock library and provides
 * a NestJS-idiomatic API with automatic key prefixing, structured logging,
 * event emission, lock groups, and FIFO queued locking.
 *
 * Extends Node's EventEmitter — hook into LockEvent.* for metrics/observability.
 *
 * @example
 * // Basic usage
 * const result = await this.lockService.withLock(
 *   'payment:process',
 *   async () => processPayment(orderId),
 *   { duration: 10_000 },
 * );
 *
 * @example
 * // Listen to events
 * lockService.on(LockEvent.ACQUIRED, (resource, durationMs) => {
 *   metrics.increment('lock.acquired', { resource });
 * });
 */
@Injectable()
export class LockService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(LockService.name);
  private readonly redlock: Redlock;
  private readonly keyPrefix: string;
  private readonly defaultDuration: number;
  private readonly retryCount: number;
  private readonly retryDelay: number;
  private readonly retryJitter: number;
  private readonly fenceCounterIdleTtl: number | undefined;
  private readonly exposeToDecorator: boolean;

  constructor(
    @Inject(LOCK_MODULE_OPTIONS)
    private readonly options: LockModuleOptions,
  ) {
    super();
    this.keyPrefix = options.keyPrefix ?? 'lock';
    this.defaultDuration = options.duration ?? 5000;
    this.retryCount = options.retryCount ?? 3;
    this.retryDelay = options.retryDelay ?? 200;
    this.retryJitter = options.retryJitter ?? 100;
    this.fenceCounterIdleTtl = options.fenceCounterIdleTtl;
    this.exposeToDecorator = options.exposeToDecorator ?? true;
    this.setMaxListeners(options.maxListeners ?? 10);

    this.redlock = new Redlock(options.clients, {
      driftFactor: options.driftFactor ?? 0.01,
      retryCount: this.retryCount,
      retryDelay: this.retryDelay,
      retryJitter: this.retryJitter,
    });

    // Makes this instance reachable from the @Lock() decorator, which has no DI.
    if (this.exposeToDecorator) {
      setActiveLockService(this, computeConfigFingerprint(options));
    }

    this.registerSemaphoreCommands(options.clients[0]);
    this.registerReadWriteCommands(options.clients[0]);
  }

  /**
   * Registers the semaphore's Lua commands on the client, guarded so it's
   * safe to call every time a LockService is constructed against a client
   * that may already have them (or, in unit tests, may be a plain mock with
   * no `defineCommand` at all).
   */
  private registerSemaphoreCommands(client: SemaphoreClient): void {
    if (typeof client.defineCommand !== 'function') {
      return;
    }
    if (typeof client.semaphoreAcquire !== 'function') {
      client.defineCommand('semaphoreAcquire', { numberOfKeys: 1, lua: SEMAPHORE_ACQUIRE_LUA });
    }
    if (typeof client.semaphoreExtend !== 'function') {
      client.defineCommand('semaphoreExtend', { numberOfKeys: 1, lua: SEMAPHORE_EXTEND_LUA });
    }
  }

  /** Same registration guard as {@link registerSemaphoreCommands}, for the read-write lock's commands. */
  private registerReadWriteCommands(client: ReadWriteClient): void {
    if (typeof client.defineCommand !== 'function') {
      return;
    }
    if (typeof client.rwAcquireRead !== 'function') {
      client.defineCommand('rwAcquireRead', { numberOfKeys: 3, lua: RW_ACQUIRE_READ_LUA });
    }
    if (typeof client.rwAcquireWrite !== 'function') {
      client.defineCommand('rwAcquireWrite', { numberOfKeys: 2, lua: RW_ACQUIRE_WRITE_LUA });
    }
    if (typeof client.rwExtendWrite !== 'function') {
      client.defineCommand('rwExtendWrite', { numberOfKeys: 1, lua: RW_EXTEND_WRITE_LUA });
    }
    if (typeof client.rwReleaseWrite !== 'function') {
      client.defineCommand('rwReleaseWrite', { numberOfKeys: 1, lua: RW_RELEASE_WRITE_LUA });
    }
  }

  /**
   * Acquires a lock (or group of locks), executes the callback, then releases
   * in a finally block — even if the callback throws.
   *
   * Pass a `string[]` for atomic multi-resource locking (lock groups).
   * Resources are sorted before acquisition to prevent deadlock.
   *
   * Pass `{ queue: true }` for FIFO ordering — callers are served in arrival
   * order instead of competing with random retry jitter.
   *
   * The callback receives an `AbortSignal` that fires if `autoExtend` fails
   * to renew the lock mid-callback (only meaningful with `autoExtend: true`
   * — without it, nothing polls the lock's health and the signal simply
   * never fires), and a {@link FencingToken}: a monotonically increasing
   * integer your storage layer can use to reject a stale write from an
   * expired holder. Both are optional to consume — existing zero-arg
   * callbacks keep working unchanged.
   *
   * @example
   * // Single resource
   * const result = await lockService.withLock('booking:42', async () => book());
   *
   * @example
   * // Lock group — atomic, deadlock-safe
   * await lockService.withLock(['seat:A1', 'seat:B2'], async () => swapSeats());
   *
   * @example
   * // Queued — FIFO fairness
   * await lockService.withLock('report:gen', () => generateReport(), {
   *   duration: 30_000,
   *   queue: true,
   * });
   *
   * @example
   * // Fencing token — protect a storage write against a stale, expired holder
   * await lockService.withLock('inventory:sku-42', async (_signal, fencingToken) => {
   *   await db.updateWithFence('sku-42', newQty, fencingToken);
   * });
   *
   * @example
   * // AbortSignal — bail out promptly if auto-extend loses the lock
   * await lockService.withLock(
   *   'long-job',
   *   async (signal) => {
   *     for await (const chunk of source) {
   *       if (signal.aborted) throw new Error('lock lost mid-job');
   *       await process(chunk);
   *     }
   *   },
   *   { autoExtend: true, duration: 10_000 },
   * );
   */
  async withLock<T>(
    resource: string | string[],
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    options?: LockCallOptions,
  ): Promise<T>;
  /**
   * @deprecated Pass a {@link LockCallOptions} object instead — this positional
   * form does not extend cleanly as options are added. Still fully supported.
   *
   * @example
   * // Old: withLock(key, cb, 5000, true, false)
   * // New: withLock(key, cb, { duration: 5000, autoExtend: true })
   */
  async withLock<T>(
    resource: string | string[],
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    duration?: number,
    autoExtend?: boolean,
    queue?: boolean,
  ): Promise<T>;
  async withLock<T>(
    resource: string | string[],
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    durationOrOptions?: number | LockCallOptions,
    autoExtend?: boolean,
    queue?: boolean,
  ): Promise<T> {
    const opts: LockCallOptions =
      typeof durationOrOptions === 'object' && durationOrOptions !== null
        ? durationOrOptions
        : { duration: durationOrOptions, autoExtend, queue };

    const ttl = opts.duration ?? this.defaultDuration;

    if (Array.isArray(resource)) {
      if (opts.queue) {
        throw new Error(
          'queue: true is not supported for lock groups (array resources). ' +
            'Queue a single coordinating resource instead, or drop the queue option ' +
            `for [${resource.join(', ')}].`,
        );
      }
      if (opts.maxConcurrent !== undefined) {
        throw new Error(
          'maxConcurrent is not supported for lock groups (array resources). ' +
            'Use a single coordinating resource for the semaphore instead, or drop ' +
            `maxConcurrent for [${resource.join(', ')}].`,
        );
      }
      if (opts.mode !== undefined) {
        throw new Error(
          'mode (read/write) is not supported for lock groups (array resources). ' +
            'Use a single coordinating resource for the read-write lock instead, or drop ' +
            `mode for [${resource.join(', ')}].`,
        );
      }
      const sorted = [...resource].sort();
      const keys = sorted.map((r) => this.buildKey(r));
      return this.runWithLock(
        () => this.acquireRedlock(keys, ttl),
        `[${keys.join(', ')}]`,
        sorted.join(','),
        callback,
        ttl,
        opts.autoExtend,
      );
    }

    if (opts.mode !== undefined && (opts.queue || opts.maxConcurrent !== undefined)) {
      throw new Error(
        `mode cannot be combined with queue or maxConcurrent for "${resource}". ` +
          'A read-write lock already provides its own admission and ordering.',
      );
    }

    if (opts.mode !== undefined) {
      return this.withReadWriteLock(resource, opts.mode, callback, ttl, opts);
    }

    if (opts.queue && opts.maxConcurrent !== undefined) {
      throw new Error(
        `queue and maxConcurrent cannot be combined for "${resource}". ` +
          'maxConcurrent already provides FIFO-ordered admission — drop queue: true.',
      );
    }

    if (opts.maxConcurrent !== undefined) {
      if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1) {
        throw new Error(
          `maxConcurrent must be a positive integer, got ${String(opts.maxConcurrent)} for "${resource}".`,
        );
      }
      return this.withSemaphoreLock(resource, callback, ttl, opts);
    }

    if (opts.queue) {
      return this.withQueuedLock(resource, callback, ttl, opts);
    }

    const key = this.buildKey(resource);
    return this.runWithLock(
      () => this.acquireRedlock([key], ttl),
      `"${key}"`,
      resource,
      callback,
      ttl,
      opts.autoExtend,
    );
  }

  /**
   * Attempts to acquire a lock without throwing when the resource is held.
   * Returns null only for genuine contention — infrastructure failures
   * (Redis unreachable, quorum lost) are re-thrown so callers and health
   * checks can tell "busy" apart from "broken".
   *
   * @example
   * const lock = await lockService.tryLock('cron:daily-sync', 30000);
   * if (!lock) return; // Another instance is already running
   */
  async tryLock(resource: string, duration?: number): Promise<Lock | null> {
    const key = this.buildKey(resource);
    const ttl = duration ?? this.defaultDuration;

    try {
      const lock = await this.redlock.acquire([key], ttl);
      this.logger.debug(`tryLock acquired "${key}"`);
      return lock;
    } catch (err) {
      if (await this.isContention(err)) {
        this.logger.debug(`tryLock: "${key}" is already held`);
        return null;
      }
      this.logger.error(`tryLock failed for "${key}" (Redis unreachable?): ${String(err)}`);
      throw err;
    }
  }

  /**
   * Like {@link tryLock}, but also returns a {@link FencingToken} — a
   * monotonically increasing integer your storage layer can use to reject a
   * stale write from an expired holder. Returns null under the same
   * contention rules as `tryLock`.
   *
   * @example
   * const acquired = await lockService.tryLockWithToken('inventory:sku-42', 5000);
   * if (!acquired) return;
   * const { lock, fencingToken } = acquired;
   * try {
   *   await db.updateWithFence('sku-42', newQty, fencingToken);
   * } finally {
   *   await lock.release();
   * }
   */
  async tryLockWithToken(
    resource: string,
    duration?: number,
  ): Promise<{ lock: Lock; fencingToken: FencingToken } | null> {
    const lock = await this.tryLock(resource, duration);
    if (!lock) {
      return null;
    }
    const fencingToken = await this.nextFencingToken(resource);
    return { lock, fencingToken };
  }

  /**
   * Extends an existing lock's TTL.
   * Throws LockExtendException if the lock has already expired.
   *
   * @example
   * let lock = await lockService.tryLock('long-job', 5000);
   * // ... time passes ...
   * lock = await lockService.extend(lock, 5000);
   */
  async extend(lock: Lock, duration: number): Promise<Lock> {
    const resource = lock.resources[0] ?? 'unknown';

    try {
      const extended = await lock.extend(duration);
      this.logger.debug(`Lock extended for "${resource}" (new ttl: ${duration}ms)`);
      this.emit(LockEvent.EXTENDED, resource, duration);
      return extended;
    } catch (err) {
      this.logger.error(`Failed to extend lock for "${resource}": ${String(err)}`);
      throw new LockExtendException(resource);
    }
  }

  /**
   * Checks if a resource is currently locked. Point-in-time check —
   * use for informational purposes only, not for locking decisions.
   *
   * Read-only: unlike an acquire-probe, this never denies a real acquirer
   * and never waits on retries.
   *
   * @example
   * const busy = await lockService.isLocked('payment:process');
   * if (busy) console.log('Payment processor is currently running');
   */
  async isLocked(resource: string): Promise<boolean> {
    const exists = await this.options.clients[0].exists(this.buildKey(resource));
    return exists > 0;
  }

  /**
   * @internal Called by NestJS when the module is destroyed.
   *
   * Leaves the Redis clients open unless `closeClientsOnDestroy` is set —
   * `redlock.quit()` closes the clients the *caller* constructed, which may
   * be shared with the rest of their application.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.exposeToDecorator) {
      clearActiveLockService(this);
    }

    if (!this.options.closeClientsOnDestroy) {
      return;
    }

    try {
      await this.redlock.quit();
      this.logger.debug('Redlock connections closed');
    } catch (err) {
      this.logger.error(`Error closing Redlock connections: ${String(err)}`);
    }
  }

  // --- Typed event emitter overloads -------------------------------------
  // EventEmitter's own signatures are untyped (`string | symbol`, `any[]`).
  // These overloads make a typo'd event name or a mismatched payload a
  // compile error instead of a silently-dead listener, while keeping the
  // untyped form available for any event name not in LockEventPayloads.

  override on<E extends keyof LockEventPayloads>(
    event: E,
    listener: (...args: LockEventPayloads[E]) => void,
  ): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override once<E extends keyof LockEventPayloads>(
    event: E,
    listener: (...args: LockEventPayloads[E]) => void,
  ): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override once(event: string | symbol, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  override emit<E extends keyof LockEventPayloads>(
    event: E,
    ...args: LockEventPayloads[E]
  ): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * The single acquire → execute → release path shared by every locking mode
   * (mutex, group, queue, semaphore, read-write). Each mode supplies its own
   * `acquire()` closure returning an `InternalLockHandle`; this method owns
   * auto-extension, the AbortSignal that fires on extend failure, fencing
   * token issuance, event emission, and release-in-finally.
   */
  private async runWithLock<T>(
    acquire: () => Promise<InternalLockHandle>,
    keyLabel: string,
    label: string,
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    ttl: number,
    autoExtend?: boolean,
  ): Promise<T> {
    let handle: InternalLockHandle;
    const acquiredAt = Date.now();

    try {
      handle = await acquire();
      this.logger.debug(`Lock acquired for ${keyLabel} (ttl: ${ttl}ms)`);
      this.emit(LockEvent.ACQUIRED, label, ttl);
    } catch (err) {
      const estimatedWaitMs =
        this.retryCount * (this.retryDelay + Math.floor(this.retryJitter / 2));
      this.logger.warn(
        `Failed to acquire lock for ${keyLabel} after ${this.retryCount} retries (~${estimatedWaitMs}ms)`,
      );
      this.emit(LockEvent.FAILED, label, String(err));
      throw new LockAcquisitionException(label, this.retryCount, estimatedWaitMs);
    }

    const controller = new AbortController();

    let extendInterval: ReturnType<typeof setInterval> | undefined;
    if (autoExtend) {
      // Floor at 50ms so a tiny ttl can't spin the event loop on extends.
      const intervalMs = Math.max(50, Math.floor(ttl / 2));
      extendInterval = setInterval(() => {
        handle
          .extend(ttl)
          .then(() => {
            this.logger.debug(`Auto-extended lock for ${keyLabel} (ttl: ${ttl}ms)`);
            this.emit(LockEvent.EXTENDED, label, ttl);
          })
          .catch((err: unknown) => {
            this.logger.warn(`Failed to auto-extend lock for ${keyLabel}: ${String(err)}`);
            this.emit(LockEvent.EXTEND_FAILED, label, String(err));
            if (extendInterval !== undefined) {
              clearInterval(extendInterval);
              extendInterval = undefined;
            }
            controller.abort(new Error(`Lock lost for ${keyLabel}: ${String(err)}`));
          });
      }, intervalMs);
    }

    try {
      const fencingToken = await this.nextFencingToken(label);
      return await callback(controller.signal, fencingToken);
    } finally {
      if (extendInterval !== undefined) {
        clearInterval(extendInterval);
      }
      const heldForMs = Date.now() - acquiredAt;
      try {
        await handle.release();
        this.logger.debug(`Lock released for ${keyLabel} (held: ${heldForMs}ms)`);
        this.emit(LockEvent.RELEASED, label, heldForMs);
      } catch (releaseErr) {
        this.logger.warn(
          `Failed to release lock for ${keyLabel}: ${String(releaseErr)}. ` +
            `The lock will expire after ${ttl}ms via Redis TTL.`,
        );
        this.emit(LockEvent.RELEASE_FAILED, label, String(releaseErr));
      }
    }
  }

  private acquireRedlock(keys: string[], ttl: number): Promise<InternalLockHandle> {
    return this.redlock.acquire(keys, ttl).then((lock) => new RedlockHandle(lock, keys));
  }

  /**
   * Issues the next {@link FencingToken} for a resource label via a plain
   * `INCR` — atomic on its own, and issuance order already matches
   * acquisition order because this is only called after a caller has won
   * admission through the mutex/queue/semaphore/read-write gate.
   *
   * If `fenceCounterIdleTtl` is configured, the counter's TTL is refreshed
   * (not set atomically with the INCR — a missed refresh only ever narrows
   * the safe-idle window, it can't cause an unsafe reset while the label is
   * still active) so it only expires after that many milliseconds of no
   * acquisitions at all for this label.
   */
  private async nextFencingToken(label: string): Promise<FencingToken> {
    const client = this.options.clients[0];
    const key = `${this.buildKey(label)}:fence`;
    const next = await client.incr(key);
    if (this.fenceCounterIdleTtl !== undefined) {
      await client.pexpire(key, this.fenceCounterIdleTtl);
    }
    return next;
  }

  /**
   * Randomized delay between busy-poll iterations for the queue/semaphore/
   * read-write loops below, reusing `retryJitter` (the same option Redlock's
   * own retries use) so waiters that started polling around the same moment
   * desynchronize over time instead of hitting Redis in lockstep every
   * `retryDelay` ms indefinitely.
   */
  private jitteredPollDelay(): number {
    const jitter = this.retryJitter > 0 ? Math.floor(Math.random() * this.retryJitter) : 0;
    return Math.max(10, this.retryDelay) + jitter;
  }

  /**
   * FIFO queued locking. A Redis sorted set decides *who goes next*; the
   * underlying Redlock lock enforces that *only one goes at a time*.
   *
   * That layering matters. A queue on its own cannot provide mutual exclusion,
   * and leaning on the lock means a crashed holder is covered by the TTL rather
   * than stalling the line forever.
   *
   * Ordering comes from a monotonic `INCR` sequence, never from wall-clock
   * time or the caller's deadline — scoring by deadline would let a caller
   * with a short timeout jump ahead of one that had been waiting longer.
   * Each waiter's own deadline rides along inside the member (`deadline|uuid`)
   * so a crashed waiter can be evicted without blocking everyone behind it.
   *
   * Only the head of the queue attempts acquisition, which is what keeps the
   * retry stampede away.
   */
  private async withQueuedLock<T>(
    resource: string,
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    ttl: number,
    options: LockCallOptions,
  ): Promise<T> {
    const key = this.buildKey(resource);
    const queueKey = `${key}:queue`;
    const seqKey = `${key}:seq`;
    const client = this.options.clients[0];
    const queueTimeout = options.queueTimeout ?? ttl * 3;
    const deadline = Date.now() + queueTimeout;
    const member = `${deadline}|${randomUUID()}`;

    const sequence = await client.incr(seqKey);
    await client.zadd(queueKey, 'NX', sequence, member);
    const rank = await client.zrank(queueKey, member);
    this.emit(LockEvent.QUEUED, resource, (rank ?? 0) + 1);

    try {
      for (;;) {
        if (Date.now() >= deadline) {
          this.logger.warn(`Queued lock timed out for "${key}" after ${queueTimeout}ms`);
          this.emit(LockEvent.FAILED, resource, `queue timeout after ${queueTimeout}ms`);
          throw new LockAcquisitionException(resource, this.retryCount, queueTimeout);
        }

        const admitted = await this.admittedSet(client, queueKey, 1);

        if (admitted.has(member)) {
          // Our turn. The real lock still decides exclusivity.
          return await this.runWithLock(
            () => this.acquireRedlock([key], ttl),
            `"${key}"`,
            resource,
            callback,
            ttl,
            options.autoExtend,
          );
        }

        if (admitted.size === 0) {
          // Everyone ahead of us expired and we were swept too — re-enter,
          // keeping our original sequence so we don't lose our place.
          await client.zadd(queueKey, 'NX', sequence, member);
        }

        await new Promise((r) => setTimeout(r, this.jitteredPollDelay()));
      }
    } finally {
      try {
        await client.zrem(queueKey, member);
      } catch (err) {
        this.logger.warn(
          `Failed to leave the lock queue for "${key}": ${String(err)}. ` +
            `The entry is swept once its deadline passes.`,
        );
      }
    }
  }

  /**
   * `maxConcurrent: N` — up to N holders at once instead of one.
   *
   * Ordering alone cannot provide exclusion (a fairness primitive is never
   * its own source of mutual exclusion), so this reuses the FIFO ticket
   * queue purely to decide *who's in the first N* and adds a separate
   * Lua-scripted owners ZSET (`{key}:sem`) for the actual atomic admission —
   * each holder is its own uniquely-named member, so N concurrent releases
   * (`ZREM <own member>`) can never race or double-decrement anything.
   *
   * Only a caller the ticket queue has admitted into the first N ever calls
   * `semaphoreAcquire`, which is what keeps this anti-stampede in the same
   * way the plain queue is: a slot opening up doesn't trigger every waiter
   * to race Redis at once.
   */
  private async withSemaphoreLock<T>(
    resource: string,
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    ttl: number,
    options: LockCallOptions,
  ): Promise<T> {
    const maxConcurrent = options.maxConcurrent as number;
    const key = this.buildKey(resource);
    const queueKey = `${key}:sem:queue`;
    const seqKey = `${key}:sem:seq`;
    const ownersKey = `${key}:sem`;
    const client = this.options.clients[0] as SemaphoreClient &
      LockModuleOptions['clients'][number];
    const queueTimeout = options.queueTimeout ?? ttl * 3;
    const deadline = Date.now() + queueTimeout;
    const member = `${deadline}|${randomUUID()}`;

    const sequence = await client.incr(seqKey);
    await client.zadd(queueKey, 'NX', sequence, member);
    const rank = await client.zrank(queueKey, member);
    this.emit(LockEvent.QUEUED, resource, (rank ?? 0) + 1);

    try {
      for (;;) {
        if (Date.now() >= deadline) {
          this.logger.warn(`Semaphore wait timed out for "${key}" after ${queueTimeout}ms`);
          this.emit(LockEvent.FAILED, resource, `semaphore timeout after ${queueTimeout}ms`);
          throw new LockAcquisitionException(resource, this.retryCount, queueTimeout);
        }

        const admitted = await this.admittedSet(client, queueKey, maxConcurrent);

        if (admitted.has(member)) {
          const now = Date.now();
          const acquired = await client.semaphoreAcquire(
            ownersKey,
            now,
            now + ttl,
            maxConcurrent,
            member,
          );

          if (acquired === 1) {
            return await this.runWithLock(
              () => Promise.resolve(new SemaphoreHandle(client, ownersKey, member)),
              `"${key}" (semaphore, max ${maxConcurrent})`,
              resource,
              callback,
              ttl,
              options.autoExtend,
            );
          }
          // The ticket queue said we're in the first N, but the owners ZSET
          // still shows it full — a slot's occupant expired in the queue
          // view but hasn't been swept from the owners set yet. Retry
          // without losing our queue position.
        }

        if (admitted.size === 0) {
          // Everyone ahead of us expired and we were swept too — re-enter,
          // keeping our original sequence so we don't lose our place.
          await client.zadd(queueKey, 'NX', sequence, member);
        }

        await new Promise((r) => setTimeout(r, this.jitteredPollDelay()));
      }
    } finally {
      try {
        await client.zrem(queueKey, member);
      } catch (err) {
        this.logger.warn(
          `Failed to leave the semaphore queue for "${key}": ${String(err)}. ` +
            `The entry is swept once its deadline passes.`,
        );
      }
    }
  }

  /**
   * `mode: 'read' | 'write'` — any number of concurrent readers, or one
   * exclusive writer, never both. Modeled as three pieces of Redis state
   * coordinated by Lua (a mutex alone can't express "many XOR one"):
   *
   * - `{key}:rw:readers` — a ZSET of reader holders, admission-gated the
   *   same way the semaphore's owners set is.
   * - `{key}:rw:writer` — a single key holding the current writer's member,
   *   compare-and-swapped on extend/release so a stale writer can't clobber
   *   a later one.
   * - `{key}:rw:writer-waiting` — set by a writer candidate while it polls,
   *   so new readers stop being admitted once a writer is next in line —
   *   without this, a steady stream of readers could starve the writer.
   *
   * Read mode needs no ticket queue: readers never exclude each other, so
   * they simply retry admission until a writer stops holding (or waiting).
   * Write mode reuses the same FIFO ticket-queue mechanics as
   * `withQueuedLock` to serialize writer *candidates* — only the head ever
   * actively polls for the real write lock, which is what keeps this
   * anti-stampede in the same way the plain queue and semaphore are.
   */
  private async withReadWriteLock<T>(
    resource: string,
    mode: 'read' | 'write',
    callback: (signal: AbortSignal, fencingToken: FencingToken) => Promise<T>,
    ttl: number,
    options: LockCallOptions,
  ): Promise<T> {
    const key = this.buildKey(resource);
    const readersKey = `${key}:rw:readers`;
    const writerKey = `${key}:rw:writer`;
    const writerWaitingKey = `${key}:rw:writer-waiting`;
    const client = this.options.clients[0] as ReadWriteClient &
      SemaphoreClient &
      LockModuleOptions['clients'][number];
    const queueTimeout = options.queueTimeout ?? ttl * 3;
    const deadline = Date.now() + queueTimeout;
    const basePollDelay = Math.max(10, this.retryDelay);
    const member = randomUUID();

    if (mode === 'read') {
      for (;;) {
        if (Date.now() >= deadline) {
          this.logger.warn(`Read lock wait timed out for "${key}" after ${queueTimeout}ms`);
          this.emit(LockEvent.FAILED, resource, `read lock timeout after ${queueTimeout}ms`);
          throw new LockAcquisitionException(resource, this.retryCount, queueTimeout);
        }

        const now = Date.now();
        const acquired = await client.rwAcquireRead(
          readersKey,
          writerKey,
          writerWaitingKey,
          now,
          now + ttl,
          member,
        );

        if (acquired === 1) {
          return await this.runWithLock(
            () => Promise.resolve(new RwReadHandle(client, readersKey, member)),
            `"${key}" (read lock)`,
            resource,
            callback,
            ttl,
            options.autoExtend,
          );
        }

        await new Promise((r) => setTimeout(r, this.jitteredPollDelay()));
      }
    }

    // mode === 'write': serialize candidates through a FIFO ticket queue,
    // identical in mechanics to withQueuedLock's, so only the head ever
    // actively contends for the real write lock.
    const queueKey = `${key}:rw:writers:queue`;
    const seqKey = `${key}:rw:writers:seq`;
    const queueMember = `${deadline}|${member}`;

    const sequence = await client.incr(seqKey);
    await client.zadd(queueKey, 'NX', sequence, queueMember);
    const rank = await client.zrank(queueKey, queueMember);
    this.emit(LockEvent.QUEUED, resource, (rank ?? 0) + 1);

    try {
      for (;;) {
        if (Date.now() >= deadline) {
          this.logger.warn(`Write lock wait timed out for "${key}" after ${queueTimeout}ms`);
          this.emit(LockEvent.FAILED, resource, `write lock timeout after ${queueTimeout}ms`);
          throw new LockAcquisitionException(resource, this.retryCount, queueTimeout);
        }

        const admitted = await this.admittedSet(client, queueKey, 1);

        if (admitted.has(queueMember)) {
          // We're the sole writer candidate. Refresh the starvation guard
          // on every poll so new readers keep being turned away while we
          // wait for the existing ones to drain. The margin accounts for
          // jitter's worst-case gap between refreshes, not just the base
          // poll delay, so the marker can't expire between polls.
          await client.set(
            writerWaitingKey,
            member,
            'PX',
            Math.max((basePollDelay + this.retryJitter) * 3, 100),
          );

          const now = Date.now();
          const acquired = await client.rwAcquireWrite(readersKey, writerKey, now, ttl, member);

          if (acquired === 1) {
            return await this.runWithLock(
              () => Promise.resolve(new RwWriteHandle(client, writerKey, member)),
              `"${key}" (write lock)`,
              resource,
              callback,
              ttl,
              options.autoExtend,
            );
          }
          // Readers are still draining (or, in principle, another writer
          // hasn't released yet) — retry without losing queue position.
        } else if (admitted.size === 0) {
          // Everyone ahead of us expired and we were swept too — re-enter,
          // keeping our original sequence so we don't lose our place.
          await client.zadd(queueKey, 'NX', sequence, queueMember);
        }

        await new Promise((r) => setTimeout(r, this.jitteredPollDelay()));
      }
    } finally {
      try {
        await client.zrem(queueKey, queueMember);
        await client.del(writerWaitingKey);
      } catch (err) {
        this.logger.warn(
          `Failed to leave the write-lock queue for "${key}": ${String(err)}. ` +
            `The entry is swept once its deadline passes.`,
        );
      }
    }
  }

  /**
   * Returns up to `limit` earliest live (non-expired) members of a FIFO
   * queue, evicting expired entries as it scans. Used both by the plain
   * queue (`limit === 1`, "am I the head?") and by the semaphore (`limit
   * === maxConcurrent`, "am I in the first N?").
   *
   * Paginates through the ZSET rather than assuming everything fits in one
   * page, so a deep queue with a run of expired entries at the front still
   * finds the true set of live admittees instead of stopping short.
   */
  private async admittedSet(
    client: LockModuleOptions['clients'][number],
    queueKey: string,
    limit: number,
  ): Promise<Set<string>> {
    const now = Date.now();
    const pageSize = Math.max(10, limit);
    const live: string[] = [];
    let start = 0;

    for (;;) {
      const page: string[] = await client.zrange(queueKey, start, start + pageSize - 1);
      if (page.length === 0) {
        break;
      }

      for (const entry of page) {
        const entryDeadline = Number(entry.split('|')[0]);
        if (Number.isFinite(entryDeadline) && entryDeadline < now) {
          await client.zrem(queueKey, entry);
          continue;
        }
        live.push(entry);
        if (live.length >= limit) {
          return new Set(live);
        }
      }

      if (page.length < pageSize) {
        break; // reached the end of the ZSET
      }
      start += pageSize;
    }

    return new Set(live);
  }

  /**
   * Distinguishes "the resource is held by someone else" from "Redis is
   * unreachable". Redlock reports both as ExecutionError, so the votes have
   * to be inspected — otherwise an outage looks exactly like contention and
   * health checks stay green while nothing works.
   */
  private async isContention(err: unknown): Promise<boolean> {
    if (err instanceof ResourceLockedError) {
      return true;
    }
    if (!(err instanceof ExecutionError)) {
      return false;
    }

    const attempts = await Promise.all(
      err.attempts.map((attempt) => attempt.catch(() => undefined)),
    );
    const last = attempts[attempts.length - 1];

    // No usable stats means we never heard back from the nodes — treat as
    // infrastructure failure so it surfaces instead of masquerading as "busy".
    if (!last || last.votesAgainst.size === 0) {
      return false;
    }

    return [...last.votesAgainst.values()].every((voteErr) => !this.isConnectionError(voteErr));
  }

  private isConnectionError(err: Error): boolean {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && CONNECTION_ERROR_PATTERNS.includes(code)) {
      return true;
    }
    const message = err.message ?? '';
    return CONNECTION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
  }

  private buildKey(resource: string): string {
    return `${this.keyPrefix}:${resource}`;
  }
}
