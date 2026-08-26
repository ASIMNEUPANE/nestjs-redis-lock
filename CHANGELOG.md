# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-08-26

Correctness hardening. A codebase audit found real gaps behind two of 1.2.0's
headline features and three smaller rough edges; this release fixes all of
them, each backed by a real test — no new primitives, no positioning work.

### Fixed

- **`@Lock()` could route to the wrong `LockService` silently.** The
  decorator resolves exactly one `LockService` per process, and a second
  instance with a different configuration (e.g. two `LockModule.register()`
  calls) used to overwrite the active one with no warning — and destroying
  either instance cleared whichever one was active, even a different,
  still-live one. `setActiveLockService` now warns on a genuine
  configuration mismatch and names the fix (`exposeToDecorator: false` on
  the instance that shouldn't compete for `@Lock()`), and
  `clearActiveLockService` only ever clears the instance being destroyed.

- **`@Lock()` discarded the fencing token and `AbortSignal`.** The
  decorator's wrapper called the callback with zero arguments, dropping
  the two values `runWithLock` hands to every callback — the package's two
  headline v1.2.0 differentiators were invisible to its primary,
  decorator-first API. `getLockContext()` (new, exported from
  `nestjs-redlock`) reads them from inside a `@Lock()`-decorated method via
  `AsyncLocalStorage`, without changing that method's own signature.

- **Fencing-token counters grew forever.** `{keyPrefix}:{resource}:fence`
  was a bare `INCR`, never expiring — permanent Redis key growth for
  high-cardinality dynamic labels (e.g. one key per booking ID, forever).
  New `fenceCounterIdleTtl` module option refreshes the counter's TTL on
  every acquisition, so it only expires after genuine, continuous idleness
  for that label — never while in active or recurring use.

- **Queue/semaphore/read-write busy-poll loops had no jitter.** All four
  polling sites shared one fixed delay, so waiters that started polling
  around the same moment stayed synchronized indefinitely — a standing
  poll-stampede against Redis. They now reuse `retryJitter` (the same
  option Redlock's own retries already used) to randomize each poll.

- **`FakeLockService` always succeeded, regardless of `queue`,
  `maxConcurrent`, `mode`, or `autoExtend`.** No test using the fake could
  verify admission bounds, read/write exclusion, or `AbortSignal` firing.
  It now simulates all of these in-process (not timing-faithful, but real
  admission bookkeeping), plus `simulateLockLoss()` and `resetQueueState()`
  test hooks. `FakeLockService` now also `implements Pick<LockService, ...>`,
  so any future drift between the two classes' public signatures is a
  compile error — this was mandated after 1.1.0's postmortem and never
  actually built.

- **`attachOtelTracing` had no way to detach.** Repeated attachment (hot
  reload, repeated test-module construction) accumulated listeners with no
  cleanup path. It now returns a disposer that removes everything it
  attached; a new `maxListeners` module option lets you deliberately raise
  `LockService`'s `EventEmitter` threshold instead of suppressing Node's own
  leak warning.

### Added

- ESLint (flat config, `typescript-eslint` + `eslint-config-prettier`),
  wired into `npm run lint`. The dozen `eslint-disable` comments already in
  `src/` referenced a linter that was never actually installed.

## [1.2.0] — 2026-08-22

New concurrency primitives, all built on the shared acquire/extend/release core
introduced in 1.1.0's queue rewrite, plus a fencing token on every acquisition.
Every new primitive is backed by concurrency tests against real Redis, not
just mocks — the 1.1.0 postmortem's lesson (`queue: true` passed every unit
test while providing no exclusion) carries directly into how these were built.

### Added

- **Semaphore (`maxConcurrent: N`)** — allow up to N concurrent holders
  instead of one. A FIFO ticket queue decides who's in the first N; a
  separate Lua-scripted Redis set (`{key}:sem`) atomically admits at most N
  holders, each its own uniquely-named member, so N concurrent releases
  (`ZREM <own member>`) can never race or double-decrement anything. A
  fairness primitive on its own is never a substitute for real exclusion —
  the queue orders, the Lua script excludes.

- **Read-write locks (`mode: 'read' | 'write'`)** — any number of concurrent
  readers, or one exclusive writer, never both. Three pieces of Redis state
  coordinated by Lua: a readers ZSET, a single writer key
  (compare-and-swapped on extend/release), and a `writer-waiting` marker a
  writer candidate sets while it polls, so a steady stream of readers can't
  starve a waiting writer indefinitely. Rare in the Node ecosystem.

- **Fencing tokens** — every acquisition (mutex, group, queue, semaphore, or
  read-write) now hands back a monotonically increasing integer via the
  callback's second argument or `tryLockWithToken()`. This is the standard
  answer to Redlock's best-known theoretical weakness (Kleppmann, 2016): a
  lock is time-based, so a paused or GC'd holder can act again after its
  lock expired and a new holder acquired it. The package cannot force a
  downstream system to honor the token — see the README's Fencing tokens
  section for the trust boundary.

- **`AbortSignal` on lock loss** — the callback's first argument is an
  `AbortSignal` that fires when `autoExtend` fails to renew the lock
  mid-callback. Only meaningful with `autoExtend: true`; without it the
  signal is provided but never fires, since nothing periodically checks the
  lock's health.

- **Observability additions** — `LockEvent.EXTEND_FAILED`, `RELEASE_FAILED`,
  and `QUEUED` (fired from the plain queue, the semaphore, and the read-write
  lock's writer queue); typed `on()`/`once()`/`emit()` overloads keyed by
  event name, so a typo'd event or mismatched payload is now a compile error;
  and `FakeLockService` gained `simulateLocked()` / `simulateUnlocked()` /
  `simulateAllUnlocked()` plus `getCalls()` / `clearCalls()` call recording —
  it previously could only ever succeed, which made it unable to exercise an
  `onFail` branch in a test.

- **OpenTelemetry tracing (`nestjs-redlock/tracing`)** — `attachOtelTracing(lockService)`
  wires `LockService`'s events into one span per acquisition, covering queue
  wait time through release, with `EXTENDED`/`EXTEND_FAILED`/`RELEASE_FAILED`/
  `QUEUED` mirrored as span events. `@opentelemetry/api` is an optional peer
  dependency, isolated to its own entry point so importing `nestjs-redlock`
  itself never requires it to be installed. Event payloads carry a resource
  label but no per-call acquisition id, so concurrent holders of the *same*
  label are paired FIFO — exact for one holder at a time, a documented
  best-effort approximation under concurrent sharing.

### Changed

- `withLock()`'s callback signature is now `(signal, fencingToken) => Promise<T>`.
  Additive, not breaking — existing zero-arg and one-arg callbacks keep
  compiling and running unchanged.
- The "Locks are time-based, not fenced" operational note has been rewritten:
  fencing tokens are no longer something you have to build yourself.
- All three example apps now use `withLock()`'s `(signal, fencingToken)`
  callback, `maxConcurrent`, and `mode` — `basic-usage` gains a fenced,
  auto-extended counter increment; `booking-system` gains a read-write
  locked seat map and a semaphore-gated payment confirmation; `cron-dedup`'s
  README notes why `@Lock()` doesn't expose these to a decorated method.

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
