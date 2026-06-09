# nestjs-redis-lock

[![npm version](https://badge.fury.io/js/nestjs-redis-lock.svg)](https://badge.fury.io/js/nestjs-redis-lock)
[![npm downloads](https://img.shields.io/npm/dw/nestjs-redis-lock.svg)](https://www.npmjs.com/package/nestjs-redis-lock)
[![CI](https://github.com/asimneupane/nestjs-redis-lock/actions/workflows/ci.yml/badge.svg)](https://github.com/asimneupane/nestjs-redis-lock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-ready distributed locking for NestJS. Decorator-first, type-safe.

## Why this package?

| Feature | nestjs-redis-lock | @anchan828/nest-redlock (archived) | nestjs-redlock |
|---|---|---|---|
| Maintained | ✅ Yes | ❌ Archived | ✅ Yes |
| `@Lock()` decorator | ✅ Yes | ✅ Yes | ❌ No |
| `onFail: 'skip'` | ✅ Yes | ❌ No | ❌ No |
| Dynamic lock keys | ✅ Yes | ❌ No | ❌ No |
| Dual CJS + ESM | ✅ Yes | ❌ No | ❌ No |
| TypeScript strict mode | ✅ Yes | ⚠️ Partial | ⚠️ Partial |

Built from a production booking system handling 90,000+ route combinations.

## Install

```bash
npm install nestjs-redis-lock ioredis
```

## Quick Start

**Register the module once in `AppModule`:**

```typescript
import { LockModule } from 'nestjs-redis-lock';
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

**Use the `@Lock()` decorator on any route handler:**

```typescript
import { Lock } from 'nestjs-redis-lock';

@Controller('bookings')
export class BookingController {
  @Post()
  @Lock({ key: (args) => `booking:${args[0].propertyId}`, onFail: 'throw' })
  async create(@Body() dto: CreateBookingDto) {
    return this.bookingService.create(dto);
  }
}
```

**Or use `LockService` directly:**

```typescript
import { LockService } from 'nestjs-redis-lock';

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
| `key` | `string \| ((args) => string)` | **required** | Lock resource key. Static string or dynamic function. |
| `duration` | `number` | Module default (5000ms) | Lock TTL in milliseconds. |
| `onFail` | `'throw' \| 'skip'` | `'throw'` | Behavior when lock is unavailable. `'skip'` returns `undefined` silently. |

### Static key

```typescript
@Lock({ key: 'report:generate', duration: 30000 })
async generateReport(): Promise<Report> { ... }
```

### Dynamic key

```typescript
@Lock({ key: (args) => `booking:${args[0].propertyId}` })
async createBooking(@Body() dto: CreateBookingDto) { ... }
```

### Skip on failure (idempotent jobs)

```typescript
@Lock({ key: 'cron:cleanup', onFail: 'skip' })
async cleanupExpiredSessions() { ... }
```

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

## Error Handling

| Exception | HTTP Status | When |
|---|---|---|
| `LockAcquisitionException` | 409 Conflict | Lock unavailable after all retries (when `onFail: 'throw'`) |
| `LockExtendException` | 500 Internal Server Error | Lock expired before `extend()` could run |

## License

MIT — [Asim Neupane](https://github.com/asimneupane)
