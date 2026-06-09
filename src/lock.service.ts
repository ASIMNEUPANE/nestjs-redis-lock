import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import Redlock, { Lock, ExecutionError, ResourceLockedError } from 'redlock';
import { LOCK_MODULE_OPTIONS } from './constants';
import { LockModuleOptions } from './interfaces/lock-module-options';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
import { LockExtendException } from './exceptions/lock-extend.exception';

/**
 * Core distributed locking service. Wraps the redlock library and provides
 * a NestJS-idiomatic API with automatic key prefixing, structured logging,
 * and proper cleanup.
 *
 * @example
 * const result = await this.lockService.withLock(
 *   'payment:process',
 *   async () => processPayment(orderId),
 *   10000,
 * );
 */
@Injectable()
export class LockService implements OnModuleDestroy {
  private readonly logger = new Logger(LockService.name);
  private readonly redlock: Redlock;
  private readonly keyPrefix: string;
  private readonly defaultDuration: number;
  private readonly retryCount: number;

  constructor(
    @Inject(LOCK_MODULE_OPTIONS)
    private readonly options: LockModuleOptions,
  ) {
    this.keyPrefix = options.keyPrefix ?? 'lock';
    this.defaultDuration = options.duration ?? 5000;
    this.retryCount = options.retryCount ?? 3;

    this.redlock = new Redlock(options.clients, {
      driftFactor: options.driftFactor ?? 0.01,
      retryCount: this.retryCount,
      retryDelay: options.retryDelay ?? 200,
      retryJitter: options.retryJitter ?? 100,
    });
  }

  /**
   * Acquires a lock, executes the callback, then always releases the lock
   * in a finally block — even if the callback throws.
   *
   * @example
   * const result = await lockService.withLock(
   *   'booking:42',
   *   async () => createBooking(payload),
   * );
   */
  async withLock<T>(
    resource: string,
    callback: () => Promise<T>,
    duration?: number,
  ): Promise<T> {
    const key = this.buildKey(resource);
    const ttl = duration ?? this.defaultDuration;
    let lock: Lock;

    try {
      lock = await this.redlock.acquire([key], ttl);
      this.logger.debug(`Lock acquired for "${key}" (ttl: ${ttl}ms)`);
    } catch (err) {
      this.logger.warn(
        `Failed to acquire lock for "${key}" after ${this.retryCount} attempts`,
      );
      throw new LockAcquisitionException(resource, this.retryCount);
    }

    try {
      return await callback();
    } finally {
      try {
        await lock.release();
        this.logger.debug(`Lock released for "${key}"`);
      } catch (releaseErr) {
        // Do not re-throw: the callback result (or error) is more important.
        // The lock will expire naturally via Redis TTL.
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
      return extended;
    } catch (err) {
      this.logger.error(`Failed to extend lock for "${resource}": ${String(err)}`);
      throw new LockExtendException(resource);
    }
  }

  /**
   * Checks if a resource is currently locked. This is a point-in-time check
   * and should be used for informational purposes only — not for making
   * locking decisions (use withLock for that).
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

  /**
   * @internal Called by NestJS when the module is destroyed.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.redlock.quit();
      this.logger.debug('Redlock connections closed');
    } catch (err) {
      this.logger.error(`Error closing Redlock connections: ${String(err)}`);
    }
  }

  private buildKey(resource: string): string {
    return `${this.keyPrefix}:${resource}`;
  }
}
