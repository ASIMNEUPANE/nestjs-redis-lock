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
