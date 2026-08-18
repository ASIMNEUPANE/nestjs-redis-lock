import { webcrypto } from 'node:crypto';

/**
 * Exposes `globalThis.crypto` inside Jest's sandboxed node environment.
 *
 * `@nestjs/schedule` calls the *global* `crypto.randomUUID()` when registering
 * a cron job (scheduler.orchestrator.js). Node has that global from v18 on,
 * but on Node 18/20 it is a lazy accessor on the real global object, and
 * jest-environment-node does not carry it into the test realm — so the cron
 * integration suite failed on CI with "crypto is not defined" while passing
 * locally on a newer Node, where it is a plain property.
 *
 * This is a test-harness gap only. The library itself imports `randomUUID`
 * from the `crypto` module (see src/lock.service.ts), which needs no global.
 */
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}
