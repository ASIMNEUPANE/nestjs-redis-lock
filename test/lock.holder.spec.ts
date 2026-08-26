import { Logger } from '@nestjs/common';
import {
  computeConfigFingerprint,
  clearActiveLockService,
  getActiveLockService,
} from '../src/lock.holder';
import { LockService } from '../src/lock.service';

jest.mock('redlock', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    acquire: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  })),
  ExecutionError: class ExecutionError extends Error {},
  ResourceLockedError: class ResourceLockedError extends Error {},
}));

function buildService(overrides: Partial<Record<string, unknown>> = {}): LockService {
  return new LockService({ clients: [{}], ...overrides } as never);
}

describe('computeConfigFingerprint', () => {
  it('is identical for the same effective config, defaults included', () => {
    expect(computeConfigFingerprint({ keyPrefix: 'lock', duration: 5000 })).toBe(
      computeConfigFingerprint({}),
    );
  });

  it('differs when keyPrefix differs', () => {
    expect(computeConfigFingerprint({ keyPrefix: 'a' })).not.toBe(
      computeConfigFingerprint({ keyPrefix: 'b' }),
    );
  });
});

describe('lock.holder collision handling', () => {
  let warnSpy: jest.SpyInstance;
  const constructed: LockService[] = [];

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Only ever clears whichever instance is actually active — safe to call
    // for every service this test constructed, in any order.
    for (const service of constructed) {
      clearActiveLockService(service);
    }
    constructed.length = 0;
    warnSpy.mockRestore();
  });

  it('does not warn when a second LockService has the same effective config', () => {
    const a = buildService({ keyPrefix: 'same' });
    const b = buildService({ keyPrefix: 'same' });
    constructed.push(a, b);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(getActiveLockService()).toBe(b);
  });

  it('warns when a second LockService has a different effective config', () => {
    const a = buildService({ keyPrefix: 'first' });
    const b = buildService({ keyPrefix: 'second' });
    constructed.push(a, b);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/exposeToDecorator: false/);
    expect(getActiveLockService()).toBe(b);
  });

  it('destroying a non-active instance does not clear the active one', async () => {
    const a = buildService({ keyPrefix: 'first' });
    const b = buildService({ keyPrefix: 'second' });
    constructed.push(a, b);

    // b is active; destroying a (already superseded) must not affect it.
    await a.onModuleDestroy();
    expect(getActiveLockService()).toBe(b);
  });

  it('destroying the active instance clears it', async () => {
    const a = buildService({ keyPrefix: 'first' });
    constructed.push(a);

    await a.onModuleDestroy();
    expect(() => getActiveLockService()).toThrow(/LockModule\.register/);
  });

  it('exposeToDecorator: false keeps the instance out of the decorator entirely', () => {
    const a = buildService({ keyPrefix: 'first' });
    const b = buildService({ keyPrefix: 'second', exposeToDecorator: false });
    constructed.push(a, b);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(getActiveLockService()).toBe(a);
  });
});
