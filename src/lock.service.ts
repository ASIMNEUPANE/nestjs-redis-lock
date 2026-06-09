import { EventEmitter } from 'events';
import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import Redlock, { Lock, ExecutionError, ResourceLockedError } from 'redlock';
import { LOCK_MODULE_OPTIONS } from './constants';
import { LockModuleOptions } from './interfaces/lock-module-options';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
import { LockExtendException } from './exceptions/lock-extend.exception';
import { LockEvent } from './lock.events';

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
 *   10000,
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
  }

  /**
   * Acquires a lock (or group of locks), executes the callback, then releases
   * in a finally block — even if the callback throws.
   *
   * Pass a `string[]` for atomic multi-resource locking (lock groups).
   * Resources are sorted before acquisition to prevent deadlock.
   *
   * Pass `queue: true` for FIFO ordering — callers block until their turn
   * instead of competing with random retry jitter.
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
   * await lockService.withLock('report:gen', async () => generateReport(), 30000, false, true);
   */
  async withLock<T>(
    resource: string | string[],
    callback: () => Promise<T>,
    duration?: number,
    autoExtend?: boolean,
    queue?: boolean,
  ): Promise<T> {
    if (Array.isArray(resource)) {
      return this.withGroupLock(resource, callback, duration, autoExtend);
    }

    if (queue) {
      return this.withQueuedLock(resource, callback, duration);
    }

    const key = this.buildKey(resource);
    const ttl = duration ?? this.defaultDuration;
    let lock: Lock;
    const acquiredAt = Date.now();

    try {
      lock = await this.redlock.acquire([key], ttl);
      this.logger.debug(`Lock acquired for "${key}" (ttl: ${ttl}ms)`);
      this.emit(LockEvent.ACQUIRED, resource, ttl);
    } catch (err) {
      const estimatedWaitMs =
        this.retryCount * (this.retryDelay + Math.floor(this.retryJitter / 2));
      this.logger.warn(
        `Failed to acquire lock for "${key}" after ${this.retryCount} retries (~${estimatedWaitMs}ms)`,
      );
      this.emit(LockEvent.FAILED, resource, String(err));
      throw new LockAcquisitionException(resource, this.retryCount, estimatedWaitMs);
    }

    let extendInterval: ReturnType<typeof setInterval> | undefined;
    if (autoExtend) {
      extendInterval = setInterval(
        () => {
          lock
            .extend(ttl)
            .then((extended) => {
              lock = extended;
              this.logger.debug(`Auto-extended lock for "${key}" (ttl: ${ttl}ms)`);
              this.emit(LockEvent.EXTENDED, resource, ttl);
            })
            .catch((err: unknown) => {
              this.logger.warn(`Failed to auto-extend lock for "${key}": ${String(err)}`);
              if (extendInterval !== undefined) {
                clearInterval(extendInterval);
                extendInterval = undefined;
              }
            });
        },
        Math.floor(ttl / 2),
      );
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
        this.logger.debug(`Lock released for "${key}" (held: ${heldForMs}ms)`);
        this.emit(LockEvent.RELEASED, resource, heldForMs);
      } catch (releaseErr) {
        this.logger.warn(
          `Failed to release lock for "${key}": ${String(releaseErr)}. ` +
            `The lock will expire after ${ttl}ms via Redis TTL.`,
        );
      }
    }
  }

  /**
   * Attempts to acquire a lock without throwing on failure.
   * Returns null if the lock is already held.
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
      if (err instanceof ExecutionError || err instanceof ResourceLockedError) {
        this.logger.debug(`tryLock: "${key}" is already held`);
        return null;
      }
      this.logger.error(`tryLock unexpected error for "${key}": ${String(err)}`);
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
   * @example
   * const busy = await lockService.isLocked('payment:process');
   * if (busy) console.log('Payment processor is currently running');
   */
  async isLocked(resource: string): Promise<boolean> {
    const lock = await this.tryLock(resource, 1);
    if (lock === null) {
      return true;
    }
    try {
      await lock.release();
    } catch {
      // 1ms lock will expire naturally
    }
    return false;
  }

  /** @internal Called by NestJS when the module is destroyed. */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.redlock.quit();
      this.logger.debug('Redlock connections closed');
    } catch (err) {
      this.logger.error(`Error closing Redlock connections: ${String(err)}`);
    }
  }

  /**
   * Acquires multiple resources atomically in sorted order (deadlock-safe).
   * Uses Redlock's native multi-resource support.
   */
  private async withGroupLock<T>(
    resources: string[],
    callback: () => Promise<T>,
    duration?: number,
    autoExtend?: boolean,
  ): Promise<T> {
    const sorted = [...resources].sort();
    const keys = sorted.map((r) => this.buildKey(r));
    const resourceLabel = sorted.join(',');
    const ttl = duration ?? this.defaultDuration;
    let lock: Lock;
    const acquiredAt = Date.now();

    try {
      lock = await this.redlock.acquire(keys, ttl);
      this.logger.debug(`Group lock acquired for [${keys.join(', ')}] (ttl: ${ttl}ms)`);
      this.emit(LockEvent.ACQUIRED, resourceLabel, ttl);
    } catch (err) {
      const estimatedWaitMs =
        this.retryCount * (this.retryDelay + Math.floor(this.retryJitter / 2));
      this.logger.warn(`Failed to acquire group lock for [${keys.join(', ')}]`);
      this.emit(LockEvent.FAILED, resourceLabel, String(err));
      throw new LockAcquisitionException(resourceLabel, this.retryCount, estimatedWaitMs);
    }

    let extendInterval: ReturnType<typeof setInterval> | undefined;
    if (autoExtend) {
      extendInterval = setInterval(
        () => {
          lock
            .extend(ttl)
            .then((extended) => {
              lock = extended;
              this.emit(LockEvent.EXTENDED, resourceLabel, ttl);
            })
            .catch((err: unknown) => {
              this.logger.warn(
                `Failed to auto-extend group lock for [${keys.join(', ')}]: ${String(err)}`,
              );
              if (extendInterval !== undefined) {
                clearInterval(extendInterval);
                extendInterval = undefined;
              }
            });
        },
        Math.floor(ttl / 2),
      );
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
        this.logger.debug(`Group lock released for [${keys.join(', ')}] (held: ${heldForMs}ms)`);
        this.emit(LockEvent.RELEASED, resourceLabel, heldForMs);
      } catch (releaseErr) {
        this.logger.warn(
          `Failed to release group lock for [${keys.join(', ')}]: ${String(releaseErr)}. Locks will expire via Redis TTL.`,
        );
      }
    }
  }

  /**
   * FIFO queued locking via Redis List semaphore (BRPOP/RPUSH).
   * Callers block in order rather than competing with random retry jitter.
   * The semaphore token is initialized atomically (Lua) and returned to the
   * queue after each holder completes — even if the callback throws.
   */
  private async withQueuedLock<T>(
    resource: string,
    callback: () => Promise<T>,
    duration?: number,
  ): Promise<T> {
    const key = this.buildKey(resource);
    const queueKey = `${key}:queue`;
    const ttl = duration ?? this.defaultDuration;
    const client = this.options.clients[0];

    // Atomically create the semaphore token if the queue doesn't exist yet.
    // Lua ensures only one token is ever created, even under concurrency.
    const initScript =
      `if redis.call('EXISTS', KEYS[1]) == 0 then ` +
      `redis.call('RPUSH', KEYS[1], '1') end return 1`;
    await client.eval(initScript, 1, queueKey);

    // Block until the token is available. Redis List guarantees FIFO order.
    const timeoutSec = Math.ceil((ttl * 3) / 1000) + 1;
    const popped = await client.brpop(queueKey, timeoutSec);

    if (!popped) {
      const estimatedWaitMs = timeoutSec * 1000;
      this.logger.warn(`Queued lock timed out for "${key}" after ${timeoutSec}s`);
      this.emit(LockEvent.FAILED, resource, `queue timeout after ${timeoutSec}s`);
      throw new LockAcquisitionException(resource, this.retryCount, estimatedWaitMs);
    }

    this.logger.debug(`Queued lock acquired for "${key}" (ttl: ${ttl}ms)`);
    this.emit(LockEvent.ACQUIRED, resource, ttl);
    const acquiredAt = Date.now();

    try {
      return await callback();
    } finally {
      await client.rpush(queueKey, '1');
      const heldForMs = Date.now() - acquiredAt;
      this.logger.debug(`Queued lock released for "${key}" (held: ${heldForMs}ms)`);
      this.emit(LockEvent.RELEASED, resource, heldForMs);
    }
  }

  private buildKey(resource: string): string {
    return `${this.keyPrefix}:${resource}`;
  }
}
