# nestjs-redlock — cron-dedup example

Prevents duplicate cron job execution when multiple NestJS instances share the same Redis.

## The problem

In a horizontally-scaled deployment (Kubernetes, ECS, PM2 cluster), every instance has its own `@Cron` scheduler. Without coordination, every instance fires the same job at the same tick — sending duplicate emails, charging customers twice, generating duplicate reports.

## The solution

```ts
@Cron(CronExpression.EVERY_10_SECONDS)
@Lock({ key: 'cron:daily-report', onFail: 'skip' })
async generateDailyReport() {
  // Only runs on ONE instance per tick
}
```

- All instances compete for the same lock at the same time
- The first to acquire it runs the job
- The rest see `onFail: 'skip'` and silently return without error

## Run

```bash
docker run -p 6379:6379 redis:7-alpine

npm install

# Terminal 1
npm start

# Terminal 2 — second "instance" (same Redis, different process)
PORT=3003 npm start
```

Watch the logs: only one instance logs "Starting daily report" per tick.

```bash
# See which instance ran on each tick
curl http://localhost:3002/jobs/history
curl http://localhost:3003/jobs/history
```

## Key patterns shown

| Pattern | Code location |
|---|---|
| `@Lock` on a `@Cron` method | `report-job.service.ts` |
| `onFail: 'skip'` — silent skip | `@Lock({ onFail: 'skip' })` |
| Lock TTL > cron interval | `app.module.ts` `duration: 15_000` |
| `retryCount: 0` — no retry | `app.module.ts` `retryCount: 0` |

## Lock TTL sizing rule

```
lock TTL > max job duration + safety margin
```

If your job takes up to 8 seconds and fires every 10 seconds, set `duration: 12_000`. If a previous job's lock is still held when the next tick fires, the next tick skips — which is the correct behavior.
