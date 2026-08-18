import { EventEmitter } from 'events';
import { Injectable } from '@nestjs/common';
import type { Lock } from 'redlock';
import type { LockService } from './lock.service';
import type { LockCallOptions } from './interfaces/lock-call-options';
import { setActiveLockService } from './lock.holder';

/**
 * Drop-in replacement for LockService in unit tests.
 * Runs callbacks immediately without acquiring any Redis locks.
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
 */
@Injectable()
export class FakeLockService extends EventEmitter {
  constructor() {
    super();
    // Lets @Lock()-decorated methods resolve a service without LockModule.
    setActiveLockService(this as unknown as LockService);
  }

  /**
   * Runs the callback immediately without acquiring any lock.
   *
   * @example
   * const result = await fakeLockService.withLock('res', async () => 'value');
   * // result === 'value'
   */
  async withLock<T>(
    _resource: string | string[],
    callback: () => Promise<T>,
    _durationOrOptions?: number | LockCallOptions,
    _autoExtend?: boolean,
    _queue?: boolean,
  ): Promise<T> {
    return callback();
  }

  /**
   * Always returns null (lock not held).
   *
   * @example
   * const lock = await fakeLockService.tryLock('res');
   * // lock === null
   */
  async tryLock(_resource: string, _duration?: number): Promise<Lock | null> {
    return null;
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
   * Always returns false (resource not locked).
   *
   * @example
   * const locked = await fakeLockService.isLocked('res');
   * // locked === false
   */
  async isLocked(_resource: string): Promise<boolean> {
    return false;
  }
}
