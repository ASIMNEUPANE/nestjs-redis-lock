/**
 * Events emitted by LockService for observability, metrics, and debugging.
 * Hook into these to integrate with Prometheus, DataDog, Sentry, or any
 * other monitoring tool without coupling to the lock internals.
 *
 * @example
 * lockService.on(LockEvent.ACQUIRED, (resource, durationMs) => {
 *   metrics.increment('lock.acquired', { resource });
 * });
 *
 * lockService.on(LockEvent.FAILED, (resource, reason) => {
 *   sentry.captureMessage(`Lock failed: ${resource} — ${reason}`);
 * });
 *
 * lockService.on(LockEvent.RELEASED, (resource, heldForMs) => {
 *   metrics.histogram('lock.held_ms', heldForMs, { resource });
 * });
 *
 * @example
 * // Data-integrity signals — these fire when a guarantee was violated,
 * // not just when something was slow.
 * lockService.on(LockEvent.EXTEND_FAILED, (resource, reason) => {
 *   // Auto-extend lost the race: the callback may now be running past its TTL.
 *   sentry.captureMessage(`Lock extend failed: ${resource} — ${reason}`);
 * });
 *
 * lockService.on(LockEvent.QUEUED, (resource, queuePosition) => {
 *   metrics.gauge('lock.queue_position', queuePosition, { resource });
 * });
 */
export const LockEvent = {
  /** Lock successfully acquired. Payload: (resource: string, durationMs: number) */
  ACQUIRED: 'acquired',
  /** Lock released after callback completed. Payload: (resource: string, heldForMs: number) */
  RELEASED: 'released',
  /** Lock acquisition failed (all retries exhausted). Payload: (resource: string, reason: string) */
  FAILED: 'failed',
  /** Lock auto-extended mid-callback. Payload: (resource: string, newDurationMs: number) */
  EXTENDED: 'extended',
  /**
   * Auto-extend failed mid-callback — the lock may now be expired while the
   * callback keeps running. The callback's AbortSignal is aborted at the same
   * time this fires. Payload: (resource: string, reason: string)
   */
  EXTEND_FAILED: 'extend_failed',
  /**
   * Release failed after the callback completed. The lock will still expire
   * via its Redis TTL, but not before. Payload: (resource: string, reason: string)
   */
  RELEASE_FAILED: 'release_failed',
  /**
   * A caller entered a FIFO queue or semaphore/read-write waiting list.
   * Payload: (resource: string, queuePosition: number) — 1-based.
   */
  QUEUED: 'queued',
} as const;

export type LockEventType = (typeof LockEvent)[keyof typeof LockEvent];

/**
 * Maps each {@link LockEvent} to the argument tuple its listeners receive.
 * Used to give `LockService.on()`/`.once()`/`.emit()` typed overloads so a
 * typo'd event name or mismatched payload is a compile error, not a silent
 * no-op listener.
 *
 * @example
 * const payloads: LockEventPayloads = {
 *   acquired: ['payment:process', 5000],
 *   released: ['payment:process', 42],
 *   failed: ['payment:process', 'timeout'],
 *   extended: ['payment:process', 5000],
 *   extend_failed: ['payment:process', 'ECONNRESET'],
 *   release_failed: ['payment:process', 'ECONNRESET'],
 *   queued: ['payment:process', 3],
 * };
 */
export interface LockEventPayloads {
  acquired: [resource: string, durationMs: number];
  released: [resource: string, heldForMs: number];
  failed: [resource: string, reason: string];
  extended: [resource: string, newDurationMs: number];
  extend_failed: [resource: string, reason: string];
  release_failed: [resource: string, reason: string];
  queued: [resource: string, queuePosition: number];
}
