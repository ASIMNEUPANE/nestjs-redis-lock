# nestjs-redlock

[![npm version](https://badge.fury.io/js/nestjs-redlock.svg)](https://badge.fury.io/js/nestjs-redlock)
[![npm downloads](https://img.shields.io/npm/dw/nestjs-redlock.svg)](https://www.npmjs.com/package/nestjs-redlock)
[![CI](https://github.com/asimneupane/nestjs-redis-lock/actions/workflows/ci.yml/badge.svg)](https://github.com/asimneupane/nestjs-redis-lock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-ready distributed locking for NestJS. Decorator-first, type-safe.

## Why this package?

| Feature | nestjs-redlock | @anchan828/nest-redlock (archived) | nestjs-redis-lock |
|---|---|---|---|
| Maintained | ✅ Yes | ❌ Archived | ⚠️ Unmaintained |
| `@Lock()` decorator | ✅ Yes | ✅ Yes | ❌ No |
| `onFail: 'skip'` | ✅ Yes | ❌ No | ❌ No |
| Dynamic lock keys | ✅ Yes | ❌ No | ❌ No |
| Dual CJS + ESM | ✅ Yes | ❌ No | ❌ No |
| TypeScript strict mode | ✅ Yes | ⚠️ Partial | ⚠️ Partial |
| Semaphore (`maxConcurrent: N`) | ✅ Yes | ❌ No | ❌ No |
| Read-write locks | ✅ Yes | ❌ No | ❌ No |
| Fencing tokens | ✅ Yes | ❌ No | ❌ No |
| OpenTelemetry tracing | ✅ Yes (optional peer) | ❌ No | ❌ No |

Built from a production booking system handling 90,000+ route combinations.

## Install

```bash
npm install nestjs-redlock ioredis
```

## Quick Start

**Register the module once in `AppModule`:**

```typescript
import { LockModule } from 'nestjs-redlock';
import Redis from 'ioredis';

@Module({
  imports: [
    LockModule.register({
      clients: [new Redis(process.env.REDIS_URL)],
    }),
  ],
})
export class AppModule {}
```

**Use the `@Lock()` decorator on any method** — route handlers, `@Cron()` jobs, queue consumers, plain providers:

```typescript
import { Lock } from 'nestjs-redlock';

@Controller('bookings')
export class BookingController {
  @Post()
  @Lock({ key: (dto: CreateBookingDto) => `booking:${dto.propertyId}`, onFail: 'throw' })
  async create(@Body() dto: CreateBookingDto) {
    return this.bookingService.create(dto);
  }
}
```

**Or use `LockService` directly:**

```typescript
import { LockService } from 'nestjs-redlock';

@Injectable()
export class PaymentService {
  constructor(private readonly lockService: LockService) {}

  async processPayment(orderId: string) {
    return this.lockService.withLock(
      `payment:${orderId}`,
      async () => this.chargeCard(orderId),
      10000,
    );
  }
}
```

## Service API

### `withLock<T>(resource, callback, options?): Promise<T>`

Acquire → execute → release. The safe default for all locking. Always releases in `finally`, even if the callback throws.

The callback receives an `AbortSignal` (fires if `autoExtend` fails to renew the
lock mid-callback — see [AbortSignal on lock loss](#abortsignal-on-lock-loss))
and a [fencing token](#fencing-tokens). Both are optional to consume.

```typescript
const result = await lockService.withLock('inventory:update', async () => {
  return updateStock(productId, quantity);
});
```

`options` also accepts `queue: true` (FIFO fairness), `maxConcurrent: N`
([semaphore](#semaphore-maxconcurrent-n)), and `mode: 'read' | 'write'`
([read-write locks](#read-write-locks-mode)) — see their sections below.
`queue`, `maxConcurrent`, and `mode` are mutually exclusive, and none apply to
lock groups (array resources).

### `tryLock(resource, duration?): Promise<Lock | null>`

Non-throwing. Returns `null` if the lock is already held. Good for cron job deduplication.

```typescript
const lock = await lockService.tryLock('cron:daily-sync', 30000);
if (!lock) return; // Another instance is already running
try {
  await runSync();
} finally {
  await lock.release();
}
```

### `tryLockWithToken(resource, duration?): Promise<{ lock: Lock; fencingToken: FencingToken } | null>`

Like `tryLock`, but also returns a [fencing token](#fencing-tokens).

```typescript
const acquired = await lockService.tryLockWithToken('inventory:sku-42', 5000);
if (!acquired) return;
const { lock, fencingToken } = acquired;
try {
  await db.updateWithFence('sku-42', newQty, fencingToken);
} finally {
  await lock.release();
}
```

### `extend(lock, duration): Promise<Lock>`

Extend an existing lock's TTL. Throws `LockExtendException` if the lock has already expired.

```typescript
lock = await lockService.extend(lock, 5000);
```

### `isLocked(resource): Promise<boolean>`

Point-in-time check. Informational only — do not use for locking decisions.

```typescript
const busy = await lockService.isLocked('payment:process');
```

## Decorator Options

| Option | Type | Default | Description |
|---|---|---|---|
| `key` | `string \| string[] \| ((...args) => string \| string[])` | **required** | Lock resource key. Static, array, or a function receiving the method's own arguments. |
| `duration` | `number` | Module default (5000ms) | Lock TTL in milliseconds. |
| `onFail` | `'throw' \| 'skip'` | `'throw'` | Behavior when lock is unavailable. `'skip'` returns `undefined` silently. |
| `autoExtend` | `boolean` | `false` | Automatically re-extend the lock every `duration/2` ms until the callback completes. |
| `queue` | `boolean` | `false` | FIFO fairness. Callers are served in arrival order instead of competing with retry jitter. |
| `maxConcurrent` | `number` | — | Semaphore: allow up to `N` concurrent holders instead of one. Mutually exclusive with `queue`, `mode`, and lock groups. |
| `mode` | `'read' \| 'write'` | — | Read-write locking: concurrent readers, exclusive writer. Mutually exclusive with `queue`, `maxConcurrent`, and lock groups. |

### Static key

```typescript
@Lock({ key: 'report:generate', duration: 30000 })
async generateReport(): Promise<Report> { ... }
```

### Dynamic key

```typescript
@Lock({ key: (dto: CreateBookingDto) => `booking:${dto.propertyId}` })
async createBooking(@Body() dto: CreateBookingDto) { ... }
```

### Skip on failure (cron deduplication)

```typescript
// Only one instance in a cluster runs this job per tick
@Cron(CronExpression.EVERY_10_SECONDS)
@Lock({ key: 'cron:cleanup', onFail: 'skip' })
async cleanupExpiredSessions() { ... }
```

### Lock groups (multi-resource atomic locking)

```typescript
// Acquire all seats atomically. Sorted key order prevents deadlocks.
@Lock({ key: (dto: SwapDto) => [`seat:${dto.seatA}`, `seat:${dto.seatB}`] })
async swapSeats(@Body() dto: SwapDto) { ... }
```

### Auto-extend for long-running operations

```typescript
// Lock automatically re-extends every duration/2 ms
@Lock({ key: 'report:generate', duration: 30000, autoExtend: true })
async generateHeavyReport() { ... }
```

### FIFO queue (fair locking)

```typescript
// Callers are served first-come-first-served, not by random retry
@Lock({ key: 'checkout:process', queue: true })
async processCheckout(@Body() dto: CheckoutDto) { ... }
```

Ordering comes from a Redis sorted set keyed on a monotonic sequence; mutual
exclusion still comes from the underlying Redlock lock, so a crashed holder is
released by its TTL rather than stalling the queue.

### Semaphore (`maxConcurrent: N`)

Allow up to `N` callers into the critical section at once instead of one —
useful for capping concurrency against a downstream dependency (a connection
pool, a rate-limited API) rather than serializing every caller.

```typescript
// At most 5 concurrent report generations across the whole cluster
@Lock({ key: 'report:generate', maxConcurrent: 5, duration: 30000 })
async generateReport() { ... }
```

Callers beyond the Nth queue FIFO (same fairness guarantee as `queue: true`)
until a slot frees up. Ordering and exclusion are separate: a ticket queue
decides who's next in line, and a Lua-scripted Redis set atomically admits at
most N holders — a fairness primitive on its own is never a substitute for
real mutual exclusion.

### Read-write locks (`mode`)

Any number of concurrent readers, or one exclusive writer — never both.

```typescript
@Lock({ key: 'catalog:sync', mode: 'read' })
async readCatalog() { ... }

@Lock({ key: 'catalog:sync', mode: 'write' })
async rebuildCatalog() { ... }
```

Write candidates queue FIFO and block new readers the moment they start
waiting, so a steady stream of readers can't starve a writer indefinitely.
This primitive is rare in the Node ecosystem — reach for it when reads vastly
outnumber writes and serializing every reader behind a plain mutex would be
unnecessarily expensive.

### Fencing tokens

Every acquisition — mutex, group, queue, semaphore, or read-write — returns a
monotonically increasing integer (`FencingToken`) alongside the callback's
other arguments (`withLock`) or from `tryLockWithToken`. This answers the
best-known theoretical weakness of the Redlock algorithm (see
[Operational notes](#operational-notes-read-before-production)): a lock is
time-based, so a paused or GC'd holder can act again after its lock has
already expired and a new holder acquired it. A fencing token lets the
*protected resource* defend against that — if your storage layer rejects any
write whose token is not strictly greater than the last one it accepted, a
late write from an expired holder is rejected even though the lock no longer
protects it.

```typescript
await lockService.withLock('inventory:sku-42', async (_signal, fencingToken) => {
  await db.query(
    'UPDATE inventory SET qty = $1, fencing_token = $2 WHERE sku = $3 AND fencing_token < $2',
    [newQty, fencingToken, 'sku-42'],
  );
});
```

**This package cannot enforce that check for you.** It only guarantees the
token increases. The protection exists only if your storage layer actually
compares it before accepting a write — a plain `UPDATE` with no such
`WHERE` clause gets no benefit from the token at all.

### AbortSignal on lock loss

The callback's first argument is an `AbortSignal` that fires if `autoExtend`
fails to renew the lock mid-callback — the one case where the lock you're
holding may no longer be yours.

```typescript
await lockService.withLock(
  'long-job',
  async (signal) => {
    for await (const chunk of source) {
      if (signal.aborted) throw new Error('lock lost mid-job');
      await process(chunk);
    }
  },
  { autoExtend: true, duration: 10_000 },
);
```

**Only meaningful with `autoExtend: true`.** Without it, nothing periodically
checks the lock's health, so the signal is provided but will never fire —
this does not by itself protect a long callback running under a lock that
simply expired. Pair it with a fencing token wherever the write itself needs
protecting, not just prompt cancellation.

### Fencing tokens and AbortSignal via `@Lock()`

`withLock()`'s callback receives `(signal, fencingToken)` directly, but a
`@Lock()`-decorated method's own signature is its real business parameters,
spread — there's no room to also append a signal and a token. Call
`getLockContext()` from inside a decorated method instead:

```typescript
import { Lock, getLockContext } from 'nestjs-redlock';

class OrderService {
  @Lock({ key: (id: string) => `order:${id}`, autoExtend: true })
  async processOrder(id: string): Promise<void> {
    const { signal, fencingToken } = getLockContext()!;
    await this.repo.applyWithFencing(id, fencingToken, signal);
  }
}
```

It returns `undefined` outside of any `@Lock()`-decorated call, and — since
it's scoped to the decorator specifically — calling `LockService.withLock()`
directly does not populate it either; that callback already gets its own
`(signal, fencingToken)` arguments. If a decorated method calls another
decorated method, `getLockContext()` inside the inner call reflects the
inner lock's own signal/token, reverting to the outer one once the inner
call returns — capture it into a local variable first if the outer method
needs its own values again after the nested call.

## Configuration

### Synchronous

```typescript
LockModule.register({
  clients: [new Redis()],        // required: one or more ioredis instances
  duration: 5000,                // default lock TTL (ms)
  retryCount: 3,                 // acquisition retries
  retryDelay: 200,                 // delay between retries (ms)
  retryJitter: 100,                // random jitter added to delay (ms) — also randomizes queue/semaphore/RW poll intervals
  driftFactor: 0.01,             // clock drift compensation
  keyPrefix: 'lock',             // prefix for all lock keys
  exposeToDecorator: true,       // false if this instance shouldn't compete for @Lock() — see Operational notes
  fenceCounterIdleTtl: undefined, // ms of inactivity before a fencing-token counter may expire — see Fencing tokens
  maxListeners: 10,              // EventEmitter.setMaxListeners() — raise only if you intentionally attach >10 listeners per event
})
```

### Async (with ConfigService)

```typescript
LockModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    clients: [new Redis(config.get('REDIS_URL'))],
    duration: config.get<number>('LOCK_TTL', 5000),
  }),
})
```

### Production: Multi-node Redlock

```typescript
LockModule.register({
  // 3+ Redis nodes for consensus-based locking
  clients: [
    new Redis({ host: 'redis-1', port: 6379 }),
    new Redis({ host: 'redis-2', port: 6379 }),
    new Redis({ host: 'redis-3', port: 6379 }),
  ],
})
```

| Option | Default | Description |
|---|---|---|
| `clients` | **required** | ioredis `Redis` instances (1 for dev, 3+ for prod) |
| `duration` | `5000` | Default lock TTL in milliseconds |
| `retryCount` | `3` | Number of acquisition retry attempts |
| `retryDelay` | `200` | Base delay between retries (ms) |
| `retryJitter` | `100` | Random jitter added to retry delay (ms) |
| `driftFactor` | `0.01` | Clock drift compensation factor |
| `keyPrefix` | `'lock'` | Prefix for all Redis lock keys |

## Events (Prometheus / DataDog / Sentry)

`LockService` extends Node's `EventEmitter`. Hook into lock lifecycle events for metrics and alerting:

```typescript
import { LockService, LockEvent } from 'nestjs-redlock';

@Injectable()
export class MetricsService {
  constructor(lockService: LockService) {
    lockService.on(LockEvent.ACQUIRED, (resource: string, duration: number) => {
      prometheus.counter('lock_acquired_total').inc({ resource });
    });

    lockService.on(LockEvent.RELEASED, (resource: string, heldForMs: number) => {
      prometheus.histogram('lock_held_duration_ms').observe({ resource }, heldForMs);
    });

    lockService.on(LockEvent.FAILED, (resource: string, reason: Error) => {
      sentry.captureException(reason, { extra: { resource } });
    });

    lockService.on(LockEvent.EXTENDED, (resource: string, newDuration: number) => {
      prometheus.counter('lock_extended_total').inc({ resource });
    });

    // Data-integrity signals — these fire when a guarantee was violated,
    // not just when something was slow.
    lockService.on(LockEvent.EXTEND_FAILED, (resource: string, reason: string) => {
      sentry.captureMessage(`Lock extend failed: ${resource} — ${reason}`);
    });
  }
}
```

`on`/`once`/`emit` are typed against each event's real payload — a typo'd
event name or mismatched listener signature is a compile error, not a
silently-dead listener.

| Event | Arguments | Fired when |
|---|---|---|
| `LockEvent.ACQUIRED` | `resource, duration` | Lock successfully acquired |
| `LockEvent.RELEASED` | `resource, heldForMs` | Lock released (success or error) |
| `LockEvent.FAILED` | `resource, error` | Lock acquisition failed |
| `LockEvent.EXTENDED` | `resource, newDuration` | Lock TTL extended |
| `LockEvent.EXTEND_FAILED` | `resource, reason` | Auto-extend failed mid-callback — the AbortSignal fires at the same time |
| `LockEvent.RELEASE_FAILED` | `resource, reason` | Release failed after the callback completed (the TTL will still expire it) |
| `LockEvent.QUEUED` | `resource, queuePosition` | A caller entered a FIFO queue, semaphore, or read-write waiting list (1-based position) |

## OpenTelemetry tracing

`nestjs-redlock/tracing` wires `LockService`'s events into OpenTelemetry spans — one span per
acquisition, covering queue wait time (if any) through release, with `lock.resource`,
`lock.duration_ms`, and `lock.held_ms` attributes and `EXTENDED`/`EXTEND_FAILED`/
`RELEASE_FAILED`/`QUEUED` mirrored 1:1 as span events.

`@opentelemetry/api` is an **optional peer dependency** — it lives at its own entry point
specifically so importing `nestjs-redlock` itself never requires OpenTelemetry to be
installed:

```bash
npm install @opentelemetry/api
```

```typescript
import { LockService } from 'nestjs-redlock';
import { attachOtelTracing } from 'nestjs-redlock/tracing';

const lockService = app.get(LockService);
const detach = attachOtelTracing(lockService);
// later, e.g. in onModuleDestroy(): detach();
```

`attachOtelTracing` returns a disposer that removes all the listeners it
attached — call it once no locks are actively being tracked (detaching
mid-flight leaves any in-flight spans open rather than fabricating a status
for an acquisition that may still be underway). Without ever calling it,
repeated `attachOtelTracing()` calls on the same `LockService` (hot reload,
repeated test-module construction) accumulate listeners with no automatic
cleanup — Node's own `MaxListenersExceededWarning` is the intended signal
something forgot to detach; see `maxListeners` in [Configuration](#configuration)
to raise the threshold deliberately instead of suppressing the warning.

**Correlation limitation:** events carry a resource label, not a per-call acquisition id, so
concurrent holders of the *same* label (a semaphore, a read-write lock's readers, or a lock
group reused by multiple callers) are paired FIFO — exact for one holder at a time, a
documented best-effort approximation when several holders share a label concurrently.

## Testing (FakeLockService)

Replace `LockService` with `FakeLockService` in unit tests — no Redis required:

```typescript
import { FakeLockService } from 'nestjs-redlock/testing';
import { LockService } from 'nestjs-redlock';

describe('PaymentService', () => {
  let service: PaymentService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: LockService, useClass: FakeLockService },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  it('processes payment', async () => {
    // withLock() simply runs the callback — no Redis, no retries
    await expect(service.processPayment('order-123')).resolves.toBeDefined();
  });
});
```

By default every call succeeds — `simulateLocked(resource)` makes a specific
resource behave as if another caller held it, so you can exercise
`onFail: 'throw'` / `onFail: 'skip'` branches without Redis:

```typescript
const fake = new FakeLockService();
fake.simulateLocked('seat:A1');
await expect(fake.withLock('seat:A1', async () => 'booked')).rejects.toThrow();

fake.simulateUnlocked('seat:A1'); // or simulateAllUnlocked()
```

`getCalls()` returns every `withLock`/`tryLock`/`tryLockWithToken` call made
so far (method, resource, options, timestamp) — useful for asserting *which*
resource your code locked without depending on Redis state. `clearCalls()`
resets the log.

`queue: true`, `maxConcurrent`, and `mode: 'read' | 'write'` are also
simulated — in-process admission bookkeeping, not a timing-faithful
reimplementation — so a test can assert an admission bound, read/write
exclusion, or FIFO-ish hand-off without Redis:

```typescript
// Only 2 callers admitted at once; a 3rd blocks until one releases.
await Promise.all([
  fake.withLock('pool', () => doWork(), { maxConcurrent: 2 }),
  fake.withLock('pool', () => doWork(), { maxConcurrent: 2 }),
]);
```

`simulateLockLoss(resource)` aborts the signal of every in-flight `withLock`
callback for that resource — regardless of `autoExtend` — for testing an
AbortSignal-aware callback without waiting on real auto-extend failure.
`resetQueueState(resource?)` discards simulated admission bookkeeping left
behind by an abandoned holder (e.g. a leaked promise from an earlier test),
so a later acquisition for that resource isn't blocked by it.

## Error Handling

| Exception | HTTP Status | When |
|---|---|---|
| `LockAcquisitionException` | 409 Conflict | Lock unavailable after all retries (when `onFail: 'throw'`) |
| `LockExtendException` | 500 Internal Server Error | Lock expired before `extend()` could run |

## Operational notes (read before production)

Distributed locking has real failure modes. These are the ones that matter here.

**A single Redis node is not fault-tolerant.** Redlock's guarantees come from a
quorum across independent masters. With `clients: [oneRedis]` you get a
convenient mutex, but if that node fails or fails over to a replica that hasn't
received the lock key, two holders can exist at once. Use 3 or 5 *independent*
masters (not a primary plus replicas) when correctness matters.

```typescript
LockModule.register({
  clients: [new Redis(node1), new Redis(node2), new Redis(node3)],
});
```

**Locks are time-based, not fenced by default.** A lock can expire while your
callback is still running — GC pause, slow query, network stall — and another
worker may then hold it legitimately. `autoExtend: true` narrows that window
(and its `AbortSignal` lets your callback notice), but neither can close it
outright: a paused process can resume after the signal fired and keep writing.
This is the well-known critique of Redlock, and it applies to every
Redis-based lock, this one included. What this package *does* provide is a
[fencing token](#fencing-tokens) on every acquisition — but the token only
protects a write if your storage layer is the one checking it. Make the
protected write idempotent, or have it reject a token that isn't strictly
greater than the last one it accepted.

**Cluster and Sentinel.** Redis Cluster does not give Redlock independent
masters — a lock key lives on one shard, so a shard failover has the same
split-brain exposure as a single node. Prefer separate standalone masters.
With Sentinel, point each client at a different Sentinel-managed master rather
than several clients at the same one.

**Key prefixes.** All keys are namespaced `{keyPrefix}:{resource}` (default
`lock`). Give each application its own `keyPrefix` when several share a Redis,
or unrelated services will contend on identical resource names.

**`@Lock()` resolves exactly one `LockService` per process.** It has no DI —
it resolves whichever `LockService` was constructed most recently. If your
process legitimately constructs more than one (e.g. two `LockModule.register()`
calls with different configs), the earlier one's decorated methods silently
start acquiring locks under the later one's config. A mismatched second
registration logs a warning naming this; pass `exposeToDecorator: false` on
the instance that shouldn't compete for `@Lock()`, and inject its
`LockService` directly instead.

**Fencing-token counters can grow without bound.** `{keyPrefix}:{resource}:fence`
is a plain, never-expiring `INCR` counter — one permanent key per distinct
label for a high-cardinality dynamic key (e.g. `booking:${bookingId}`). Set
`fenceCounterIdleTtl` to let a counter expire after genuine, continuous
idleness (the TTL is refreshed on every acquisition, so it never resets while
the label is in active or recurring use) if unbounded key growth is a concern.

**`redlock@5` is still a beta release.** It is the most complete Redlock
implementation for Node and is in wide production use, but the version pinned
here (`^5.0.0-beta.2`) carries that label upstream.

## Migrating from `@anchan828/nest-redlock`

`@anchan828/nest-redlock` has been archived and is no longer maintained. Here's how to migrate in 3 steps.

### 1. Update dependencies

```bash
npm uninstall @anchan828/nest-redlock
npm install nestjs-redlock
```

### 2. Update module registration

```typescript
// Before
import { RedlockModule } from '@anchan828/nest-redlock';
RedlockModule.registerAsync({
  useFactory: () => ({
    clients: [new Redis()],
    settings: { retryCount: 3 },
  }),
})

// After
import { LockModule } from 'nestjs-redlock';
LockModule.register({
  clients: [new Redis()],
  retryCount: 3,        // flat options — no nested "settings" object
})
```

### 3. Update decorators

```typescript
// Before
import { Redlock } from '@anchan828/nest-redlock';
@Redlock(['resource'])
async myMethod() { ... }

// After
import { Lock } from 'nestjs-redlock';
@Lock({ key: 'resource' })
async myMethod() { ... }
```

### What you gain

- **Dynamic lock keys** — `key: (dto) => \`booking:\${dto.id}\``
- **`onFail: 'skip'`** — silent skip for cron jobs, no try/catch needed
- **Lock groups** — atomic multi-resource locking with deadlock prevention
- **Event emitter** — Prometheus/DataDog/Sentry hooks
- **FIFO queued locking** — fair ordering instead of random retry stampede
- **`FakeLockService`** — unit tests with zero Redis dependency
- **Dual CJS + ESM** — works in modern ESM projects
- **Active maintenance** — no archived package risk

## License

MIT — [Asim Neupane](https://github.com/asimneupane)
