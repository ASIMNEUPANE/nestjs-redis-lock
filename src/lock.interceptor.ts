import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { LOCK_METADATA_KEY } from './constants';
import { LockDecoratorOptions } from './interfaces/lock-options';
import { LockService } from './lock.service';
import { LockAcquisitionException } from './exceptions/lock-acquisition.exception';

/**
 * Legacy interceptor-based locking. Reads @Lock() metadata from the route
 * handler, acquires the lock, then releases it after the handler completes.
 *
 * @deprecated `@Lock()` now wraps the method directly and no longer applies
 * this interceptor. Two reasons it was replaced: interceptors only run in the
 * request pipeline (so `@Cron` and plain provider methods were never locked),
 * and the key function here receives `ExecutionContext.getArgs()` — for HTTP
 * that is `[req, res, next]`, not the handler's parameters. Kept exported for
 * anyone who wired it manually via `UseInterceptors`.
 *
 * @example
 * // Only if you are wiring it by hand — @Lock() no longer needs this:
 * \@UseInterceptors(LockInterceptor)
 * \@SetMetadata(LOCK_METADATA_KEY, { key: 'my-resource' })
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
        {
          duration: options.duration,
          autoExtend: options.autoExtend,
          queue: options.queue,
        },
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
