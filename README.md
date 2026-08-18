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

### `withLock<T>(resource, callback, duration?): Promise<T>`

Acquire → execute → release. The safe default for all locking. Always releases in `finally`, even if the callback throws.

```typescript
const result = await lockService.withLock('inventory:update', async () => {
  return updateStock(productId, quantity);
});
```

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

## Configuration

### Synchronous

```typescript
LockModule.register({
  clients: [new Redis()],        // required: one or more ioredis instances
  duration: 5000,                // default lock TTL (ms)
  retryCount: 3,                 // acquisition retries
  retryDelay: 200,               // delay between retries (ms)
  retryJitter: 100,              // random jitter added to delay (ms)
  driftFactor: 0.01,             // clock drift compensation
  keyPrefix: 'lock',             // prefix for all lock keys
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
  }
}
```

| Event | Arguments | Fired when |
|---|---|---|
| `LockEvent.ACQUIRED` | `resource, duration` | Lock successfully acquired |
| `LockEvent.RELEASED` | `resource, heldForMs` | Lock released (success or error) |
| `LockEvent.FAILED` | `resource, error` | Lock acquisition failed |
| `LockEvent.EXTENDED` | `resource, newDuration` | Lock TTL extended |

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

**Locks are time-based, not fenced.** A lock can expire while your callback is
still running — GC pause, slow query, network stall — and another worker may
then hold it legitimately. `autoExtend: true` narrows that window but cannot
close it. For operations where a double-execution is unacceptable, make the
protected write idempotent or guard it with a fencing token / conditional
update in your database. This is the well-known critique of Redlock, and it
applies to every Redis-based lock, this one included.

**Cluster and Sentinel.** Redis Cluster does not give Redlock independent
masters — a lock key lives on one shard, so a shard failover has the same
split-brain exposure as a single node. Prefer separate standalone masters.
With Sentinel, point each client at a different Sentinel-managed master rather
than several clients at the same one.

**Key prefixes.** All keys are namespaced `{keyPrefix}:{resource}` (default
`lock`). Give each application its own `keyPrefix` when several share a Redis,
or unrelated services will contend on identical resource names.

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
