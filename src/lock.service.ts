import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import Redlock, { Lock, ExecutionError, ResourceLockedError } from 'redlock';
import { LOCK_MODULE_OPTIONS } from './constants';
import { LockModuleOptions } from './interfaces/lock-module-options';
import { LockCallOptions } from './interfaces/lock-call-options';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
import { LockExtendException } from './exceptions/lock-extend.exception';
import { LockEvent } from './lock.events';
import { setActiveLockService, clearActiveLockService } from './lock.holder';

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

    this.redlock = new Redlock(options.clients, {
      driftFactor: options.driftFactor ?? 0.01,
      retryCount: this.retryCount,
      retryDelay: this.retryDelay,
      retryJitter: this.retryJitter,
    });

    // Makes this instance reachable from the @Lock() decorator, which has no DI.
    setActiveLockService(this);
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
   */
  async withLock<T>(
    resource: string | string[],
    callback: () => Promise<T>,
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
    callback: () => Promise<T>,
    duration?: number,
    autoExtend?: boolean,
    queue?: boolean,
  ): Promise<T>;
  async withLock<T>(
    resource: string | string[],
    callback: () => Promise<T>,
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
      const sorted = [...resource].sort();
      return this.runWithLock(
        sorted.map((r) => this.buildKey(r)),
        sorted.join(','),
        callback,
        ttl,
        opts.autoExtend,
      );
    }

    if (opts.queue) {
      return this.withQueuedLock(resource, callback, ttl, opts);
    }

    return this.runWithLock([this.buildKey(resource)], resource, callback, ttl, opts.autoExtend);
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
    clearActiveLockService();

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

  /**
   * The single acquire → execute → release path shared by every locking mode.
   * Handles auto-extension, event emission, and release-in-finally.
   */
  private async runWithLock<T>(
    keys: string[],
    label: string,
    callback: () => Promise<T>,
    ttl: number,
    autoExtend?: boolean,
  ): Promise<T> {
    const keyLabel = keys.length === 1 ? `"${keys[0]}"` : `[${keys.join(', ')}]`;
    let lock: Lock;
    const acquiredAt = Date.now();

    try {
      lock = await this.redlock.acquire(keys, ttl);
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

    let extendInterval: ReturnType<typeof setInterval> | undefined;
    if (autoExtend) {
      // Floor at 50ms so a tiny ttl can't spin the event loop on extends.
      const intervalMs = Math.max(50, Math.floor(ttl / 2));
      extendInterval = setInterval(() => {
        lock
          .extend(ttl)
          .then((extended) => {
            lock = extended;
            this.logger.debug(`Auto-extended lock for ${keyLabel} (ttl: ${ttl}ms)`);
            this.emit(LockEvent.EXTENDED, label, ttl);
          })
          .catch((err: unknown) => {
            this.logger.warn(`Failed to auto-extend lock for ${keyLabel}: ${String(err)}`);
            if (extendInterval !== undefined) {
              clearInterval(extendInterval);
              extendInterval = undefined;
            }
          });
      }, intervalMs);
    }

    try {
      return await callback();
    } finally {
      if (extendInterval !== undefined) {
        clearInterval(extendInterval);
      }
      const heldForMs = Date.now() - acquiredAt;
      try {
        await lock.release();
        this.logger.debug(`Lock released for ${keyLabel} (held: ${heldForMs}ms)`);
        this.emit(LockEvent.RELEASED, label, heldForMs);
      } catch (releaseErr) {
        this.logger.warn(
          `Failed to release lock for ${keyLabel}: ${String(releaseErr)}. ` +
            `The lock will expire after ${ttl}ms via Redis TTL.`,
        );
      }
    }
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
    callback: () => Promise<T>,
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
    const pollDelay = Math.max(10, this.retryDelay);

    const sequence = await client.incr(seqKey);
    await client.zadd(queueKey, 'NX', sequence, member);

    try {
      for (;;) {
        if (Date.now() >= deadline) {
          this.logger.warn(`Queued lock timed out for "${key}" after ${queueTimeout}ms`);
          this.emit(LockEvent.FAILED, resource, `queue timeout after ${queueTimeout}ms`);
          throw new LockAcquisitionException(resource, this.retryCount, queueTimeout);
        }

        const head = await this.headOfQueue(client, queueKey);

        if (head === member) {
          // Our turn. The real lock still decides exclusivity.
          return await this.runWithLock([key], resource, callback, ttl, options.autoExtend);
        }

        if (head === undefined) {
          // Everyone ahead of us expired and we were swept too — re-enter,
          // keeping our original sequence so we don't lose our place.
          await client.zadd(queueKey, 'NX', sequence, member);
        }

        await new Promise((r) => setTimeout(r, pollDelay));
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
   * Returns the front of the queue, first evicting any expired waiters at the
   * head. Only entries at the head can block anyone, so a small window is
   * enough — no need to scan the whole set on every poll.
   */
  private async headOfQueue(
    client: LockModuleOptions['clients'][number],
    queueKey: string,
  ): Promise<string | undefined> {
    const now = Date.now();
    const window: string[] = await client.zrange(queueKey, 0, 9);

    for (const entry of window) {
      const entryDeadline = Number(entry.split('|')[0]);
      if (Number.isFinite(entryDeadline) && entryDeadline < now) {
        await client.zrem(queueKey, entry);
        continue;
      }
      return entry;
    }

    return window.length < 10 ? undefined : ((await client.zrange(queueKey, 0, 0))[0] as string);
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
