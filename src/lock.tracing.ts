import { trace, Span, SpanStatusCode } from '@opentelemetry/api';
import { LockService } from './lock.service';
import { LockEvent, LockEventPayloads } from './lock.events';

/** Options for {@link attachOtelTracing}. */
export interface OtelLockTracingOptions {
  /**
   * The OpenTelemetry tracer name spans are recorded under.
   * @default 'nestjs-redlock'
   */
  tracerName?: string;
}

/** One in-flight acquisition's span, tracked so a later event can close it. */
interface TrackedSpan {
  span: Span;
  /** False while only QUEUED has fired for this acquisition; true once ACQUIRED has. */
  acquired: boolean;
}

/**
 * Wires a {@link LockService}'s events into OpenTelemetry spans — one span
 * per acquisition attempt, covering queue wait time (if any) through release,
 * with `lock.resource`, `lock.duration_ms`, `lock.held_ms`, and
 * `lock.fencing_token`-adjacent events attached, mirroring {@link LockEvent}
 * 1:1 as span events (`EXTENDED`, `EXTEND_FAILED`, `RELEASE_FAILED`, `QUEUED`).
 *
 * `@opentelemetry/api` is an optional peer dependency. This lives at its own
 * entry point (`nestjs-redlock/tracing`) rather than the package root
 * specifically so importing `nestjs-redlock` itself never requires
 * OpenTelemetry to be installed — only code that imports this subpath does.
 *
 * **Correlation limitation:** events carry a resource label but no per-call
 * acquisition id, so concurrent holders of the *same* label (a semaphore, a
 * read-write lock's readers, or a lock group re-used from multiple callers)
 * are paired FIFO — the oldest still-open span for that label closes on the
 * next terminal event. For the common case of one holder per resource at a
 * time this is exact; under concurrent sharing it is a documented
 * best-effort approximation, not a per-call guarantee.
 *
 * Returns a disposer that removes all listeners this attached. Call it once
 * no locks are actively being tracked (e.g. during shutdown) — detaching
 * mid-flight leaves any in-flight spans permanently open rather than
 * fabricating a status for an acquisition that may still be legitimately
 * underway. Without ever calling the disposer, repeated `attachOtelTracing()`
 * calls on the same LockService (hot reload, repeated test-module
 * construction) accumulate listeners with no automatic cleanup — Node's own
 * `MaxListenersExceededWarning` is the intended signal something forgot to
 * detach; see `LockModuleOptions.maxListeners` to raise the threshold
 * deliberately instead of suppressing the warning.
 *
 * @example
 * import { LockModule, LockService } from 'nestjs-redlock';
 * import { attachOtelTracing } from 'nestjs-redlock/tracing';
 *
 * const lockService = app.get(LockService);
 * const detach = attachOtelTracing(lockService);
 * // later, e.g. in onModuleDestroy(): detach();
 */
export function attachOtelTracing(
  lockService: LockService,
  options: OtelLockTracingOptions = {},
): () => void {
  const tracer = trace.getTracer(options.tracerName ?? 'nestjs-redlock');
  const open = new Map<string, TrackedSpan[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscriptions: Array<[keyof LockEventPayloads, (...args: any[]) => void]> = [];
  const subscribe = <E extends keyof LockEventPayloads>(
    event: E,
    listener: (...args: LockEventPayloads[E]) => void,
  ): void => {
    lockService.on(event, listener);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscriptions.push([event, listener as (...args: any[]) => void]);
  };

  const push = (resource: string, entry: TrackedSpan): void => {
    const entries = open.get(resource);
    if (entries) {
      entries.push(entry);
    } else {
      open.set(resource, [entry]);
    }
  };

  /**
   * Removes and returns a tracked span for a resource matching `predicate`,
   * preferring the oldest match — used to keep RELEASED/RELEASE_FAILED from
   * ever closing a still-waiting caller's span, and FAILED from ever
   * stealing a live, successfully-acquired holder's span.
   */
  const pop = (
    resource: string,
    predicate: (entry: TrackedSpan) => boolean,
  ): TrackedSpan | undefined => {
    const entries = open.get(resource);
    if (!entries) {
      return undefined;
    }
    const index = entries.findIndex(predicate);
    if (index === -1) {
      return undefined;
    }
    const [entry] = entries.splice(index, 1);
    if (entries.length === 0) {
      open.delete(resource);
    }
    return entry;
  };

  /** Finds the oldest not-yet-acquired tracked span for a resource, if any. */
  const takeQueued = (resource: string): TrackedSpan | undefined => {
    const entries = open.get(resource);
    return entries?.find((entry) => !entry.acquired);
  };

  /** Finds the newest already-acquired tracked span for a resource, if any. */
  const findAcquired = (resource: string): Span | undefined => {
    const entries = open.get(resource);
    return [...(entries ?? [])].reverse().find((entry) => entry.acquired)?.span;
  };

  subscribe(LockEvent.QUEUED, (resource, queuePosition) => {
    const span = tracer.startSpan(`lock.wait ${resource}`);
    span.setAttribute('lock.resource', resource);
    span.addEvent('lock.queued', { 'lock.queue_position': queuePosition });
    push(resource, { span, acquired: false });
  });

  subscribe(LockEvent.ACQUIRED, (resource, durationMs) => {
    const queued = takeQueued(resource);
    const span = queued?.span ?? tracer.startSpan(`lock.acquire ${resource}`);
    span.setAttribute('lock.resource', resource);
    span.setAttribute('lock.duration_ms', durationMs);
    span.addEvent('lock.acquired');
    if (queued) {
      queued.acquired = true;
    } else {
      push(resource, { span, acquired: true });
    }
  });

  subscribe(LockEvent.EXTENDED, (resource, newDurationMs) => {
    findAcquired(resource)?.addEvent('lock.extended', {
      'lock.new_duration_ms': newDurationMs,
    });
  });

  subscribe(LockEvent.EXTEND_FAILED, (resource, reason) => {
    const span = findAcquired(resource);
    span?.addEvent('lock.extend_failed', { 'lock.reason': reason });
    span?.setStatus({ code: SpanStatusCode.ERROR, message: reason });
  });

  subscribe(LockEvent.RELEASED, (resource, heldForMs) => {
    const span = pop(resource, (entry) => entry.acquired)?.span;
    if (!span) {
      return;
    }
    span.setAttribute('lock.held_ms', heldForMs);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });

  subscribe(LockEvent.RELEASE_FAILED, (resource, reason) => {
    const span = pop(resource, (entry) => entry.acquired)?.span;
    if (!span) {
      return;
    }
    span.addEvent('lock.release_failed', { 'lock.reason': reason });
    span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    span.end();
  });

  subscribe(LockEvent.FAILED, (resource, reason) => {
    // Fires either for a caller that never got past QUEUED (its span is
    // still unacquired) or one that failed immediately (no span yet) — cover
    // both, but never steal a span whose ACQUIRED already fired for a
    // different, concurrently-held holder of the same label.
    const span =
      pop(resource, (entry) => !entry.acquired)?.span ??
      tracer.startSpan(`lock.failed ${resource}`);
    span.setAttribute('lock.resource', resource);
    span.recordException(new Error(reason));
    span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
    span.end();
  });

  return function detachOtelTracing(): void {
    for (const [event, listener] of subscriptions) {
      lockService.off(event, listener);
    }
  };
}
