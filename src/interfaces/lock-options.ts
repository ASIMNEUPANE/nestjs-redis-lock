/**
 * Options for the @Lock() decorator.
 *
 * @example
 * \@Lock({ key: 'payment', duration: 10000, onFail: 'skip' })
 * async processPayment() { ... }
 *
 * \@Lock({ key: (args) => `booking:${args[0].id}`, onFail: 'throw' })
 * async createBooking(dto: CreateBookingDto) { ... }
 */
export interface LockDecoratorOptions {
  /**
   * The lock resource key. Can be a static string or a function
   * that receives the method arguments and returns a string.
   * Final key will be prefixed: `{keyPrefix}:{key}`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: string | ((...args: any[]) => string);

  /**
   * Lock TTL in milliseconds. Overrides the module-level default.
   * @default Module-configured duration (default: 5000)
   */
  duration?: number;

  /**
   * Behavior when lock cannot be acquired:
   * - 'throw': re-throws a LockAcquisitionException (HTTP 409). Default behavior.
   * - 'skip': silently returns undefined, useful for idempotent background jobs.
   * @default 'throw'
   */
  onFail?: 'throw' | 'skip';

  /**
   * Reserved for Phase 2: automatically extends the lock at duration/2 intervals.
   * @default false
   */
  autoExtend?: boolean;
}
