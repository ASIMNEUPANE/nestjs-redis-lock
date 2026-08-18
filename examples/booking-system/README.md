# nestjs-redlock — booking-system example

A seat-booking API that demonstrates the two race condition patterns this library was built to solve:

1. **Dynamic lock keys** — each seat gets its own lock (`seat:LOC-001:A1`), so concurrent requests for *different* seats don't block each other.
2. **Lock groups** — booking multiple seats atomically acquires all locks in sorted key order, preventing deadlocks when two requests try to book the same seats in different order.

## The problem without locks

```
Request A reads seat A1 → available
Request B reads seat A1 → available
Request A books seat A1 → OK
Request B books seat A1 → double-booking! 💥
```

## The solution

```
Request A acquires lock:seat:LOC-001:A1
Request B tries lock:seat:LOC-001:A1 → blocked
Request A reads, books, releases lock → success
Request B acquires lock → reads seat as booked → 409 Conflict
```

## Run

```bash
docker run -p 6379:6379 redis:7-alpine

npm install
npm start
```

## Try it

```bash
# Book a single seat
curl -X POST http://localhost:3001/bookings \
  -H "Content-Type: application/json" \
  -d '{"locationId":"LOC-001","seatId":"A1","userId":"user-42"}'

# Try to double-book the same seat
curl -X POST http://localhost:3001/bookings \
  -H "Content-Type: application/json" \
  -d '{"locationId":"LOC-001","seatId":"A1","userId":"user-99"}'

# Book multiple seats atomically (deadlock-safe)
curl -X POST http://localhost:3001/bookings/multi \
  -H "Content-Type: application/json" \
  -d '{"locationId":"LOC-001","seatIds":["B2","A1"],"userId":"user-99"}'

# List all bookings
curl http://localhost:3001/bookings
```

## Key patterns shown

| Pattern | Code location |
|---|---|
| Dynamic lock key from request body | `booking.controller.ts` `@Lock({ key: (dto) => ... })` |
| Lock groups (multi-resource atomic) | `booking.service.ts` `withLock(string[], ...)` |
| `onFail: 'throw'` → 409 response | `booking.controller.ts` catch block |
| `retryCount: 0` for fail-fast | `app.module.ts` `LockModule.register` |
