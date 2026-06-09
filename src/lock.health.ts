import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { LockService } from './lock.service';

/**
 * Terminus health indicator for the distributed lock service.
 * Reports healthy when a short-lived lock can be acquired and released.
 *
 * @example
 * // In your health module:
 * \@Controller('health')
 * class HealthController {
 *   constructor(
 *     private health: HealthCheckService,
 *     private lockHealth: LockHealthIndicator,
 *   ) {}
 *
 *   \@Get()
 *   \@HealthCheck()
 *   check() {
 *     return this.health.check([
 *       () => this.lockHealth.isHealthy('redis-lock'),
 *     ]);
 *   }
 * }
 */
@Injectable()
export class LockHealthIndicator extends HealthIndicator {
  constructor(private readonly lockService: LockService) {
    super();
  }

  /**
   * Checks health by attempting to acquire a 1-second lock on a sentinel resource.
   * Returns healthy if the lock round-trip succeeds; unhealthy otherwise.
   *
   * @param key - The key used in the health check result (default: 'redis-lock')
   *
   * @example
   * const result = await lockHealthIndicator.isHealthy('redis-lock');
   * // { 'redis-lock': { status: 'up' } }
   */
  async isHealthy(key = 'redis-lock'): Promise<HealthIndicatorResult> {
    try {
      const lock = await this.lockService.tryLock('__health-check__', 1000);
      if (lock) {
        try {
          await lock.release();
        } catch {
          // 1-second TTL — will expire naturally
        }
      }
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError(
        'LockService is unhealthy',
        this.getStatus(key, false, { error: String(err) }),
      );
    }
  }
}
