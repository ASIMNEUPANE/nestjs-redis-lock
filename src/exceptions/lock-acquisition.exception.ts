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
  constructor(resource: string, retryCount: number, estimatedWaitMs: number) {
    super(
      {
        statusCode: HttpStatus.CONFLICT,
        error: 'Lock Acquisition Failed',
        message:
          `Failed to acquire lock for resource "${resource}" after ${retryCount} retries ` +
          `(~${estimatedWaitMs}ms wait). ` +
          `Another process holds this lock. Wait and retry your request, or increase retryCount/retryDelay in LockModule config.`,
      },
      HttpStatus.CONFLICT,
    );
  }
}
