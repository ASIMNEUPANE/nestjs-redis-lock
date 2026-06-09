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
} as const;

export type LockEventType = (typeof LockEvent)[keyof typeof LockEvent];
