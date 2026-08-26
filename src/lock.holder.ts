import { Logger } from '@nestjs/common';
import type { LockService } from './lock.service';

interface ActiveRegistration {
  service: LockService;
  fingerprint: string;
}

/**
 * Module-scoped reference to the active LockService instance.
 *
 * Decorators are evaluated at class-definition time, long before the NestJS
 * DI container exists, so `@Lock()` cannot receive LockService by injection.
 * LockService registers itself here on construction, and the decorator's
 * wrapper resolves it lazily at call time — by which point the module is up.
 */
let active: ActiveRegistration | undefined;

const logger = new Logger('LockService');

/**
 * Builds a stable fingerprint for the subset of LockModuleOptions that
 * changes @Lock()'s observable behavior, so setActiveLockService can tell
 * "a second LockService with the same config" (harmless — e.g. repeated
 * TestingModule construction) apart from "a second LockService with a
 * genuinely different config" (a real collision worth warning about).
 *
 * @internal
 */
export function computeConfigFingerprint(options: {
  keyPrefix?: string;
  duration?: number;
  retryCount?: number;
  retryDelay?: number;
  retryJitter?: number;
  driftFactor?: number;
}): string {
  return JSON.stringify([
    options.keyPrefix ?? 'lock',
    options.duration ?? 5000,
    options.retryCount ?? 3,
    options.retryDelay ?? 200,
    options.retryJitter ?? 100,
    options.driftFactor ?? 0.01,
  ]);
}

/**
 * Registers the LockService instance that `@Lock()` will use.
 * Called by the LockService constructor — not part of the public API.
 *
 * If a different LockService with a different configuration is already
 * active, this warns instead of silently taking over — every @Lock()
 * anywhere in the process now resolves to this instance, including
 * decorated methods that logically belong to the other module.
 *
 * @internal
 *
 * @example
 * // Inside LockService's constructor:
 * setActiveLockService(this, computeConfigFingerprint(options));
 */
export function setActiveLockService(service: LockService, fingerprint: string): void {
  if (active && active.service !== service && active.fingerprint !== fingerprint) {
    logger.warn(
      'A second LockService with a different configuration was constructed while another is ' +
        'still active. @Lock() resolves exactly one LockService per process, so this one now ' +
        'wins for every @Lock()-decorated method application-wide — including ones that ' +
        "logically belong to the first module (e.g. a different keyPrefix means those methods' " +
        "locks now acquire under this instance's prefix instead). If this is intentional, pass " +
        '{ exposeToDecorator: false } to the LockModule.register() call that should not compete ' +
        'for @Lock(), and inject its LockService directly instead of using the decorator.',
    );
  }
  active = { service, fingerprint };
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
  if (!active) {
    throw new Error(
      '@Lock() was called before LockModule was registered. ' +
        'Add LockModule.register({ clients: [new Redis()] }) (or registerAsync) to your ' +
        'AppModule imports. If the decorated method runs during module initialization, ' +
        'move the call into onApplicationBootstrap() or use LockService.withLock() directly.',
    );
  }
  return active.service;
}

/**
 * Clears the active LockService, but only if `service` is the one currently
 * active. A LockService being destroyed while a *different*, still-live
 * LockService is active must not clear that other instance out from under
 * it — this is what module teardown and FakeLockService's constructor rely
 * on when more than one LockService/FakeLockService exists in a process.
 *
 * @internal
 *
 * @example
 * afterEach(() => clearActiveLockService(myLockService));
 */
export function clearActiveLockService(service: LockService): void {
  if (active?.service === service) {
    active = undefined;
  }
}
