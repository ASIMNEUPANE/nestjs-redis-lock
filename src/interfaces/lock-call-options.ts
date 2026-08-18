/**
 * Options for a single `LockService.withLock()` call.
 *
 * Prefer this over the deprecated positional form — it stays readable as
 * options are added, and it is the form the `@Lock()` decorator uses internally.
 *
 * @example
 * await lockService.withLock('report:generate', () => run(), {
 *   duration: 30_000,
 *   autoExtend: true,
 * });
 *
 * @example
 * // FIFO fairness under contention
 * await lockService.withLock('invoice:batch', () => run(), { queue: true });
 */
export interface LockCallOptions {
  /**
   * Lock TTL in milliseconds. Overrides the module-level default.
   * @default Module-configured duration (default: 5000)
   */
  duration?: number;

  /**
   * Extends the lock at `duration / 2` intervals so long-running callbacks
   * never lose their lock mid-execution.
   * @default false
   */
  autoExtend?: boolean;

  /**
   * Enable FIFO queued locking. Callers are served in arrival order instead of
   * competing with random retry jitter, which removes the retry stampede.
   *
   * Ordering comes from a Redis sorted set; mutual exclusion still comes from
   * the underlying Redlock lock, so a crashed holder is covered by the TTL.
   * @default false
   */
  queue?: boolean;

  /**
   * How long to wait in the FIFO queue before giving up, in milliseconds.
   * Only meaningful with `queue: true`.
   * @default duration * 3
   */
  queueTimeout?: number;
}
