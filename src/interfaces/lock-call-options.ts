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

  /**
   * Allow up to `N` concurrent holders instead of one. Callers beyond the
   * Nth queue (FIFO, same fairness guarantee as `queue: true`) until a slot
   * frees up. Mutually exclusive with `queue` and with array (lock group)
   * resources.
   *
   * @default undefined (plain mutex — at most 1 holder)
   */
  maxConcurrent?: number;

  /**
   * Read-write locking: any number of concurrent `'read'` holders, or one
   * exclusive `'write'` holder — never both at once. Write candidates queue
   * FIFO and block new readers while they wait, so a busy resource can't
   * starve a writer indefinitely. Mutually exclusive with `queue`,
   * `maxConcurrent`, and array (lock group) resources.
   *
   * @default undefined (plain mutex — at most 1 holder, no read/write distinction)
   */
  mode?: 'read' | 'write';
}
