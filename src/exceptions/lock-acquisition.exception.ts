import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Thrown when a distributed lock cannot be acquired after all retries.
 * Maps to HTTP 409 Conflict.
 *
 * @example
 * try {
 *   await lockService.withLock('resource', callback);
 * } catch (err) {
 *   if (err instanceof LockAcquisitionException) {
 *     // 409 — another process holds the lock
 *   }
 * }
 */
export class LockAcquisitionException extends HttpException {
  constructor(resource: string, retryCount: number) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Lock Acquisition Failed',
        message:
          `Failed to acquire lock for resource "${resource}" after ${retryCount} attempts. ` +
          `Another process may hold this lock. Retry your request or contact support.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}
