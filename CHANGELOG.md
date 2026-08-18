# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-08-18

A correctness release. An audit of v1.0.0 found three advertised features that
compiled, logged success, passed their tests, and provided **no locking**. If
you use `queue: true`, dynamic `@Lock()` keys, or `@Lock()` on scheduled jobs,
upgrade.

### Fixed

- **`queue: true` provided no mutual exclusion.** The FIFO queue was a Redis
  List holding one token. `BRPOP` popped the only element, which deleted the
  now-empty key, so the next caller's init script saw no key and minted a
  *second* token. N callers each got their own token and ran concurrently.
  Verified against real Redis: two staggered callers both entered the critical
  section, and the semaphore was left holding 2 tokens — degrading further on
  every cycle.

  Queued locking is now layered correctly: a sorted set ordered by a monotonic
  `INCR` sequence decides *who goes next*, and the underlying Redlock lock
  enforces that *only one goes at a time*. A crashed holder is released by the
  lock's TTL; a crashed waiter is swept by its own deadline instead of stalling
  the line. Only the head of the queue attempts acquisition, preserving the
  anti-stampede property.

- **Dynamic `@Lock()` keys resolved to `undefined` in real HTTP handlers.** The
  key function received `ExecutionContext.getArgs()`, which for HTTP is
  `[req, res, next]` — not the handler's parameters. A key like
  `` (dto) => `seat:${dto.locationId}` `` produced `"seat:undefined"`, so every
  request locked the *same* key: worse than no lock, since it serialized
  unrelated requests while appearing to work.

- **`@Lock()` was a no-op on `@Cron()` handlers and all provider methods.** It
  applied a NestJS interceptor, and interceptors only run in the request
  pipeline. `@nestjs/schedule` invokes methods directly, so scheduled-job
  deduplication — a headline use case — never locked.

- **The health check could never report unhealthy.** `tryLock()` treated
  redlock's `ExecutionError` as contention, but redlock throws the same error
  when it cannot reach a quorum because Redis is down. `LockHealthIndicator`
  reported `up` against a dead Redis. `tryLock()` now inspects the failed
  votes and re-throws infrastructure failures instead of reporting them as
  "already held".

- **The e2e suite had never executed.** `testRegex` required a literal `.`
  before `spec` while the file was named `lock.e2e-spec.ts`, so CI provisioned
  a Redis service on every job that nothing ever connected to.

- **`isLocked()` had side effects.** It probed by acquiring a real 1 ms lock,
  which could deny a legitimate acquirer, and inherited the retry settings, so
  it could block ~600 ms before answering. It is now a read-only `EXISTS`.

- **Module shutdown closed Redis clients it did not own.** `onModuleDestroy`
  called `redlock.quit()`, closing the clients *you* constructed and may share
  with the rest of your app. Now opt-in via `closeClientsOnDestroy: true`.

- `queue: true` combined with an array resource was silently ignored. It now
  throws an actionable error.

### Changed

- **`@Lock()` wraps the method instead of installing an interceptor.** It works
  on any method — routes, `@Cron()` handlers, queue consumers, plain providers.
  All metadata and the function name are copied onto the wrapper, so route and
  cron registration are unaffected.

- **Key functions now receive the method's own arguments, spread**, so they are
  type-inferrable:

  ```diff
  - @Lock({ key: (args) => `seat:${args[0].seatId}` })       // got [req, res, next]
  + @Lock({ key: (dto: BookSeatDto) => `seat:${dto.seatId}` })
  ```

- **`withLock()` accepts an options object.** The positional form still works
  and is deprecated:

  ```diff
  - withLock(key, cb, 5000, true, false)
  + withLock(key, cb, { duration: 5000, autoExtend: true })
  ```

- `LockInterceptor` is still exported for anyone wiring it manually, now marked
  deprecated. `@Lock()` no longer applies it.

- Auto-extend intervals are floored at 50 ms so a very small TTL cannot spin
  the event loop.

### Added

- `LockCallOptions` with a `queueTimeout` option.
- `closeClientsOnDestroy` module option (default `false`).
- An integration suite that runs against real Redis (`npm run test:e2e`), wired
  into CI. It asserts mutual exclusion under 50 concurrent callers across the
  default, group, and queued paths — the class of test that would have caught
  every defect above. Unit tests grew from 90 to 110.
- `npm run typecheck` (`tsc --noEmit`), now part of `npm run lint` and
  `prepublishOnly`.
- README section on single-node Redlock, fencing tokens, Cluster/Sentinel, and
  key-prefix collisions.
- `FakeLockService` registers itself as the active lock service, so
  `@Lock()`-decorated methods work in unit tests without Redis.

### Migration

Most users need no changes. Two cases do:

1. **Dynamic key functions** — the parameter is now the argument itself, not an
   args array. Any key that was silently producing `undefined` starts producing
   the correct key, which changes which resources contend.
2. **Relying on module shutdown closing your Redis clients** — set
   `closeClientsOnDestroy: true` to keep that behavior.

## [1.0.0] — 2026-06-10

Initial stable release: `@Lock()` decorator, `LockService`, lock groups, queued
locking, auto-extend, events, Terminus health indicator, `FakeLockService`, and
three example applications.
