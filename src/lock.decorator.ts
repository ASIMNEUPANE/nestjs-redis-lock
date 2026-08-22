import { SetMetadata } from '@nestjs/common';
import { LockDecoratorOptions } from './interfaces/lock-options';
import { LOCK_METADATA_KEY } from './constants';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
import { getActiveLockService } from './lock.holder';

/**
 * Copies every Reflect metadata entry from the original method onto the
 * wrapper, then restores the function name.
 *
 * NestJS and its ecosystem read metadata off the method function itself —
 * route metadata from `@Post()`, `design:paramtypes` for DI, `@Cron()`
 * registration from `@nestjs/schedule`. Replacing `descriptor.value` without
 * carrying that across silently unregisters routes and scheduled jobs
 * depending on decorator order.
 */
function inheritMethodMetadata(original: (...args: never[]) => unknown, wrapper: object): void {
  for (const key of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapper);
  }
  Object.defineProperty(wrapper, 'name', {
    value: original.name,
    configurable: true,
  });
}

/**
 * Method decorator that acquires a distributed Redis lock before executing
 * the decorated method and releases it when the method completes.
 *
 * Works on **any** method — controller routes, `@Cron()` handlers, queue
 * consumers, and plain provider methods — because it wraps the method itself
 * rather than relying on the NestJS request pipeline.
 *
 * Key functions receive the method's own arguments, spread.
 *
 * @param options - Lock configuration including key, duration, and failure behavior.
 *
 * @example
 * // Static key
 * \@Lock({ key: 'report:generate', duration: 30000 })
 * async generateReport(): Promise<Report> { ... }
 *
 * @example
 * // Dynamic key from the method's real arguments
 * \@Lock({ key: (dto: CreateBookingDto) => `booking:${dto.propertyId}` })
 * async createBooking(\@Body() dto: CreateBookingDto): Promise<Booking> { ... }
 *
 * @example
 * // Scheduled job dedup across a cluster — losers skip their tick
 * \@Cron(CronExpression.EVERY_10_SECONDS)
 * \@Lock({ key: 'cron:daily-report', onFail: 'skip' })
 * async generateDailyReport(): Promise<void> { ... }
 */
export function Lock(options: LockDecoratorOptions): MethodDecorator {
  return <T>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): TypedPropertyDescriptor<T> | void => {
    const original = descriptor.value as unknown as (...args: never[]) => Promise<unknown>;

    if (typeof original !== 'function') {
      throw new Error(
        `@Lock() can only decorate methods, but was applied to ` +
          `"${String(propertyKey)}" on ${target.constructor?.name ?? 'an unknown class'}. ` +
          `Move it onto a method.`,
      );
    }

    async function wrapped(this: unknown, ...args: never[]): Promise<unknown> {
      const lockService = getActiveLockService();
      const resource =
        typeof options.key === 'function'
          ? (options.key as (...a: never[]) => string | string[])(...args)
          : options.key;

      try {
        return await lockService.withLock(resource, () => original.apply(this, args), {
          duration: options.duration,
          autoExtend: options.autoExtend,
          queue: options.queue,
          maxConcurrent: options.maxConcurrent,
          mode: options.mode,
        });
      } catch (err) {
        if (options.onFail === 'skip' && err instanceof LockAcquisitionException) {
          return undefined;
        }
        throw err;
      }
    }

    inheritMethodMetadata(original, wrapped);
    descriptor.value = wrapped as unknown as T;
    SetMetadata(LOCK_METADATA_KEY, options)(target, propertyKey, descriptor);

    return descriptor;
  };
}
