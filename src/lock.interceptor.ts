import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { LOCK_METADATA_KEY } from './constants';
import { LockDecoratorOptions } from './interfaces/lock-options';
import { LockService } from './lock.service';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';

/**
 * NestJS interceptor that reads @Lock() metadata from the route handler,
 * acquires the specified lock, then releases it after the handler completes.
 *
 * Registered automatically by the @Lock() decorator — do not apply manually.
 *
 * @example
 * // Applied automatically by @Lock():
 * \@Lock({ key: 'my-resource' })
 * async myHandler() { ... }
 */
@Injectable()
export class LockInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LockInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly lockService: LockService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<LockDecoratorOptions>(
      LOCK_METADATA_KEY,
      context.getHandler(),
    );

    if (!options) {
      return next.handle();
    }

    const resolvedKey =
      typeof options.key === 'function' ? options.key(context.getArgs()) : options.key;

    const onFail = options.onFail ?? 'throw';

    return from(
      this.lockService.withLock(
        resolvedKey,
        () =>
          new Promise<unknown>((resolve, reject) => {
            next.handle().subscribe({
              next: resolve,
              error: reject,
              complete: () => resolve(undefined),
            });
          }),
        options.duration,
        options.autoExtend,
        options.queue,
      ),
    ).pipe(
      catchError((err: unknown) => {
        if (onFail === 'skip' && err instanceof LockAcquisitionException) {
          this.logger.debug(`Lock acquisition skipped for "${resolvedKey}" (onFail: 'skip')`);
          return of(undefined);
        }
        throw err;
      }),
    );
  }
}
