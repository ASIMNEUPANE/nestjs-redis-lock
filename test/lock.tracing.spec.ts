import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { EventEmitter } from 'events';
import { attachOtelTracing } from '../src/lock.tracing';
import { LockEvent } from '../src/lock.events';
import { LockService } from '../src/lock.service';

/**
 * `attachOtelTracing` only calls `LockService.on(...)`/nothing else, so a
 * bare EventEmitter cast as `LockService` exercises the wiring without
 * standing up a real Redis-backed service — the tracing module never reads
 * any other member of `LockService`.
 */
function fakeLockService(): LockService {
  return new EventEmitter() as unknown as LockService;
}

describe('attachOtelTracing', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await exporter.shutdown();
    trace.disable();
  });

  function finished(): ReadableSpan[] {
    return exporter.getFinishedSpans();
  }

  it('records one OK span from ACQUIRED to RELEASED', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService);

    lockService.emit(LockEvent.ACQUIRED, 'payment:process', 5000);
    lockService.emit(LockEvent.RELEASED, 'payment:process', 42);

    const spans = finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('lock.acquire payment:process');
    expect(spans[0].attributes['lock.resource']).toBe('payment:process');
    expect(spans[0].attributes['lock.duration_ms']).toBe(5000);
    expect(spans[0].attributes['lock.held_ms']).toBe(42);
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it('records a standalone error span for an immediate FAILED with no prior QUEUED', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService);

    lockService.emit(LockEvent.FAILED, 'payment:process', 'already locked');

    const spans = finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('lock.failed payment:process');
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('already locked');
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('spans queue wait time: QUEUED then ACQUIRED then RELEASED closes one span', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService);

    lockService.emit(LockEvent.QUEUED, 'report:gen', 1);
    lockService.emit(LockEvent.ACQUIRED, 'report:gen', 30_000);
    lockService.emit(LockEvent.RELEASED, 'report:gen', 100);

    const spans = finished();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('lock.wait report:gen');
    expect(spans[0].events.map((e) => e.name)).toEqual(['lock.queued', 'lock.acquired']);
    expect(spans[0].attributes['lock.duration_ms']).toBe(30_000);
    expect(spans[0].attributes['lock.held_ms']).toBe(100);
  });

  it('closes a still-queued caller on FAILED (queue timeout) without touching an unrelated acquired holder', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService);

    // Holder A is already acquired and running.
    lockService.emit(LockEvent.QUEUED, 'invoice:batch', 1);
    lockService.emit(LockEvent.ACQUIRED, 'invoice:batch', 5000);

    // Caller B queues behind A and times out before ever acquiring.
    lockService.emit(LockEvent.QUEUED, 'invoice:batch', 2);
    lockService.emit(LockEvent.FAILED, 'invoice:batch', 'queue timeout after 15000ms');

    // Only B's span should be closed; A's is still open.
    expect(finished()).toHaveLength(1);
    expect(finished()[0].name).toBe('lock.wait invoice:batch');
    expect(finished()[0].status.code).toBe(SpanStatusCode.ERROR);

    // A finishes normally afterwards.
    lockService.emit(LockEvent.RELEASED, 'invoice:batch', 4000);
    expect(finished()).toHaveLength(2);
    expect(finished()[1].attributes['lock.held_ms']).toBe(4000);
  });

  it('records EXTENDED and EXTEND_FAILED as events on the acquired span, not a queued one', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService);

    lockService.emit(LockEvent.ACQUIRED, 'long-job', 10_000);
    lockService.emit(LockEvent.EXTENDED, 'long-job', 10_000);
    lockService.emit(LockEvent.EXTEND_FAILED, 'long-job', 'ECONNRESET');
    lockService.emit(LockEvent.RELEASE_FAILED, 'long-job', 'ECONNRESET');

    const spans = finished();
    expect(spans).toHaveLength(1);
    const eventNames = spans[0].events.map((e) => e.name);
    expect(eventNames).toEqual([
      'lock.acquired',
      'lock.extended',
      'lock.extend_failed',
      'lock.release_failed',
    ]);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('never lets RELEASED close a still-queued (not yet acquired) span', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService);

    // A caller is queued but has not yet been admitted.
    lockService.emit(LockEvent.QUEUED, 'seat:A1', 1);
    // A RELEASED for the same label with no matching acquired entry must be a no-op.
    lockService.emit(LockEvent.RELEASED, 'seat:A1', 10);

    expect(finished()).toHaveLength(0);
  });

  it('uses a custom tracer name when provided', () => {
    const lockService = fakeLockService();
    attachOtelTracing(lockService, { tracerName: 'my-app' });

    lockService.emit(LockEvent.ACQUIRED, 'x', 1000);
    lockService.emit(LockEvent.RELEASED, 'x', 1);

    expect(finished()[0].instrumentationScope.name).toBe('my-app');
  });
});
