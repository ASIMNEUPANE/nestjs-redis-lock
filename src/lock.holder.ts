import type { LockService } from './lock.service';

/**
 * Module-scoped reference to the active LockService instance.
 *
 * Decorators are evaluated at class-definition time, long before the NestJS
 * DI container exists, so `@Lock()` cannot receive LockService by injection.
 * LockService registers itself here on construction, and the decorator's
 * wrapper resolves it lazily at call time — by which point the module is up.
 */
let activeLockService: LockService | undefined;

/**
 * Registers the LockService instance that `@Lock()` will use.
 * Called by the LockService constructor — not part of the public API.
 *
 * @internal
 *
 * @example
 * // Inside LockService's constructor:
 * setActiveLockService(this);
 */
export function setActiveLockService(service: LockService): void {
  activeLockService = service;
}

/**
 * Resolves the active LockService for the `@Lock()` decorator.
 * Throws an actionable error if LockModule was never registered.
 *
 * @internal
 *
 * @example
 * const service = getActiveLockService();
 * await service.withLock('key', callback);
 */
export function getActiveLockService(): LockService {
  if (!activeLockService) {
    throw new Error(
      '@Lock() was called before LockModule was registered. ' +
        'Add LockModule.register({ clients: [new Redis()] }) (or registerAsync) to your ' +
        'AppModule imports. If the decorated method runs during module initialization, ' +
        'move the call into onApplicationBootstrap() or use LockService.withLock() directly.',
    );
  }
  return activeLockService;
}

/**
 * Clears the active LockService. Used by module teardown and by tests that
 * need to assert the "LockModule not registered" error path.
 *
 * @internal
 *
 * @example
 * afterEach(() => clearActiveLockService());
 */
export function clearActiveLockService(): void {
  activeLockService = undefined;
}
