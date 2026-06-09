import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Thrown when extending an existing lock's TTL fails.
 * Maps to HTTP 500 Internal Server Error since this is a server-side
 * state inconsistency (the lock may have already expired).
 *
 * @example
 * try {
 *   const extended = await lockService.extend(lock, 5000);
 * } catch (err) {
 *   if (err instanceof LockExtendException) {
 *     // Lock expired before extend could happen
 *   }
 * }
 */
export class LockExtendException extends HttpException {
  constructor(resource: string) {
    super(
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Lock Extend Failed',
        message:
          `Failed to extend lock for resource "${resource}". ` +
          `The lock may have expired. Acquire a new lock and retry the operation.`,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
