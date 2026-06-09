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
   * The lock resource key. Can be:
   * - A static string: `'payment:process'`
   * - A string array for lock groups (atomic multi-resource): `['seat:A1', 'seat:B2']`
   * - A function returning a string or string array (receives method args)
   *
   * Final keys are prefixed: `{keyPrefix}:{key}`.
   * For lock groups, resources are acquired in sorted order to prevent deadlock.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  key: string | string[] | ((...args: any[]) => string | string[]);

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
   * Automatically extends the lock at duration/2 intervals so long-running
   * callbacks never lose their lock mid-execution.
   * @default false
   */
  autoExtend?: boolean;

  /**
   * Enable FIFO queued locking. Callers block in arrival order (Redis BRPOP)
   * instead of competing with random retry jitter — eliminates thundering herd.
   * Uses the first Redis client in `LockModuleOptions.clients`.
   * @default false
   */
  queue?: boolean;
}
