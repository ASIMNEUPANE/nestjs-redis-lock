import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { LockInterceptor } from './lock.interceptor';
import { LockDecoratorOptions } from './interfaces/lock-options';
import { LOCK_METADATA_KEY } from './constants';

/**
 * Method decorator that acquires a distributed Redis lock before executing
 * the decorated method and releases it when the method completes.
 *
 * @param options - Lock configuration including key, duration, and failure behavior.
 *
 * @example
 * // Static key
 * \@Lock({ key: 'report:generate', duration: 30000 })
 * async generateReport(): Promise<Report> { ... }
 *
 * @example
 * // Dynamic key based on method arguments
 * \@Lock({ key: (args) => `booking:${args[0].propertyId}`, onFail: 'skip' })
 * async createBooking(\@Body() dto: CreateBookingDto): Promise<Booking> { ... }
 */
export function Lock(options: LockDecoratorOptions): MethodDecorator {
  return applyDecorators(
    SetMetadata(LOCK_METADATA_KEY, options),
    UseInterceptors(LockInterceptor),
  );
}
