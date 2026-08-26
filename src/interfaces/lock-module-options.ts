import { ModuleMetadata } from '@nestjs/common';

/**
 * Configuration options for LockModule.
 *
 * @example
 * LockModule.register({
 *   clients: [new Redis()],
 *   duration: 5000,
 *   retryCount: 3,
 * })
 */
export interface LockModuleOptions {
  /** One or more ioredis Redis instances. Use 3+ for production Redlock quorum. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  clients: any[];
  /** Default lock TTL in milliseconds. @default 5000 */
  duration?: number;
  /** Number of lock acquisition retries. @default 3 */
  retryCount?: number;
  /** Base delay between retries in milliseconds. @default 200 */
  retryDelay?: number;
  /** Random jitter added to retryDelay in milliseconds. @default 100 */
  retryJitter?: number;
  /** Clock drift compensation factor (0–1). @default 0.01 */
  driftFactor?: number;
  /** Prefix prepended to all lock keys: `{keyPrefix}:{resource}`. @default 'lock' */
  keyPrefix?: string;
  /**
   * Close the Redis clients when the module is destroyed.
   *
   * Off by default: you constructed these clients and may share them with the
   * rest of your app, so shutting the lock module down should not take your
   * application's Redis connections with it. Enable it only when the clients
   * exist solely for locking.
   *
   * @default false
   */
  closeClientsOnDestroy?: boolean;
  /**
   * Whether this LockService instance becomes reachable via the `@Lock()`
   * decorator. `@Lock()` has no DI and resolves exactly one LockService per
   * process — the one most recently constructed with this left at its
   * default. If your process constructs more than one `LockService` (e.g. a
   * second `LockModule.register()` with a different configuration), set this
   * to `false` on the one(s) that should not compete for `@Lock()`, and
   * inject their `LockService` directly instead of using the decorator.
   *
   * @default true
   */
  exposeToDecorator?: boolean;
  /**
   * Milliseconds of inactivity after which a resource's fencing-token counter
   * (`{keyPrefix}:{resource}:fence`) is allowed to expire, bounding the
   * otherwise-permanent key growth for high-cardinality dynamic labels (e.g.
   * `booking:${bookingId}`). The TTL is refreshed on every acquisition for
   * that label, so a counter only ever expires after this many milliseconds
   * during which the label was never locked at all — not while it's in
   * active or recurring use.
   *
   * Set this comfortably larger than the longest realistic gap between uses
   * of a given label, and larger than any pause (GC, process suspend,
   * network partition) you want to defend against: a holder that pauses past
   * `fenceCounterIdleTtl` while nobody else touches that label, then resumes
   * and writes after the counter has reset, defeats the fencing guarantee
   * for that specific label. This does not add a new risk beyond the one
   * fencing tokens already carry for unbounded pauses generally — it only
   * lets you trade "counters live forever" for "counters live forever unless
   * truly idle."
   *
   * @default undefined — counters never expire (pre-1.3.0 behavior).
   */
  fenceCounterIdleTtl?: number;
  /**
   * Passed to `EventEmitter.setMaxListeners()` on construction. LockService
   * extends EventEmitter; Node's own default of 10 applies per event name.
   * Only relevant if you attach more than 10 listeners to the same event
   * (e.g. `attachOtelTracing()` called repeatedly without calling its
   * returned disposer first) and want to raise the threshold deliberately
   * rather than treat Node's `MaxListenersExceededWarning` as the leak
   * signal it's meant to be.
   *
   * @default 10 — Node's own default; unset is a no-op.
   */
  maxListeners?: number;
}

/**
 * Async configuration options for LockModule.registerAsync().
 * Supports NestJS dependency injection via useFactory + inject.
 *
 * @example
 * LockModule.registerAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService) => ({
 *     clients: [new Redis(config.get('REDIS_URL'))],
 *   }),
 * })
 */
export interface LockModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => Promise<LockModuleOptions> | LockModuleOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
}
