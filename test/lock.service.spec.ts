import { Test, TestingModule } from '@nestjs/testing';
import { LockService } from '../src/lock.service';
import { LOCK_MODULE_OPTIONS } from '../src/constants';
import { LockAcquisitionException } from '../src/exceptions/lock-acquisition.exception';
import { LockExtendException } from '../src/exceptions/lock-extend.exception';
import { LockEvent } from '../src/lock.events';

const mockRelease = jest.fn().mockResolvedValue(undefined);
const mockExtend = jest.fn();
const mockLock = {
  resources: ['lock:test-resource'],
  expiration: Date.now() + 5000,
  release: mockRelease,
  extend: mockExtend,
};
const mockAcquire = jest.fn().mockResolvedValue(mockLock);
const mockQuit = jest.fn().mockResolvedValue(undefined);

jest.mock('redlock', () => {
  const MockRedlock = jest.fn().mockImplementation(() => ({
    acquire: mockAcquire,
    quit: mockQuit,
  }));
  class MockExecutionError extends Error {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(
      message: string,
      public attempts: any[],
    ) {
      super(message);
    }
  }
  class MockResourceLockedError extends Error {}
  return {
    __esModule: true,
    default: MockRedlock,
    ExecutionError: MockExecutionError,
    ResourceLockedError: MockResourceLockedError,
  };
});

describe('LockService', () => {
  let service: LockService;

  const mockEval = jest.fn().mockResolvedValue(1);
  const mockBrpop = jest.fn().mockResolvedValue(['lock:test-resource:queue', '1']);
  const mockRpush = jest.fn().mockResolvedValue(1);

  const mockOptions = {
    clients: [{ eval: mockEval, brpop: mockBrpop, rpush: mockRpush }],
    duration: 5000,
    retryCount: 3,
    retryDelay: 200,
    retryJitter: 100,
    driftFactor: 0.01,
    keyPrefix: 'lock',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAcquire.mockResolvedValue(mockLock);
    mockRelease.mockResolvedValue(undefined);
    mockEval.mockResolvedValue(1);
    mockBrpop.mockResolvedValue(['lock:test-resource:queue', '1']);
    mockRpush.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [LockService, { provide: LOCK_MODULE_OPTIONS, useValue: mockOptions }],
    }).compile();

    service = module.get<LockService>(LockService);
  });

  describe('withLock()', () => {
    it('acquires lock, runs callback, releases lock', async () => {
      const callback = jest.fn().mockResolvedValue('result');
      const result = await service.withLock('test-resource', callback);

      expect(mockAcquire).toHaveBeenCalledWith(['lock:test-resource'], 5000);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    it('releases lock in finally even when callback throws', async () => {
      const callback = jest.fn().mockRejectedValue(new Error('callback error'));

      await expect(service.withLock('test-resource', callback)).rejects.toThrow('callback error');

      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('uses custom duration when provided', async () => {
      await service.withLock('res', async () => 'x', 10000);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:res'], 10000);
    });

    it('throws LockAcquisitionException when acquire fails', async () => {
      mockAcquire.mockRejectedValueOnce(new Error('lock busy'));

      await expect(service.withLock('test-resource', async () => 'x')).rejects.toBeInstanceOf(
        LockAcquisitionException,
      );
    });

    it('LockAcquisitionException message includes retry count and wait time', async () => {
      mockAcquire.mockRejectedValueOnce(new Error('lock busy'));

      const err = await service.withLock('res', async () => 'x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LockAcquisitionException);
      const body = (err as LockAcquisitionException).getResponse() as Record<string, string>;
      expect(body.message).toMatch(/3 retries/);
      expect(body.message).toMatch(/~\d+ms wait/);
    });

    it('does not re-throw if release fails', async () => {
      mockRelease.mockRejectedValueOnce(new Error('release failed'));
      const result = await service.withLock('res', async () => 'value');
      expect(result).toBe('value');
    });

    it('uses keyPrefix from options', async () => {
      await service.withLock('my-resource', async () => null);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:my-resource'], expect.any(Number));
    });
  });

  describe('tryLock()', () => {
    it('returns Lock on success', async () => {
      const lock = await service.tryLock('res');
      expect(lock).toBe(mockLock);
    });

    it('returns null when ExecutionError is thrown', async () => {
      const { ExecutionError } = jest.requireMock('redlock');
      mockAcquire.mockRejectedValueOnce(new ExecutionError('fail', []));
      const lock = await service.tryLock('res');
      expect(lock).toBeNull();
    });

    it('returns null when ResourceLockedError is thrown', async () => {
      const { ResourceLockedError } = jest.requireMock('redlock');
      mockAcquire.mockRejectedValueOnce(new ResourceLockedError('locked'));
      const lock = await service.tryLock('res');
      expect(lock).toBeNull();
    });

    it('re-throws unexpected errors', async () => {
      mockAcquire.mockRejectedValueOnce(new TypeError('network error'));
      await expect(service.tryLock('res')).rejects.toBeInstanceOf(TypeError);
    });

    it('uses custom duration', async () => {
      await service.tryLock('res', 9000);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:res'], 9000);
    });
  });

  describe('extend()', () => {
    it('returns extended lock on success', async () => {
      const extendedLock = { ...mockLock, expiration: Date.now() + 10000 };
      mockExtend.mockResolvedValueOnce(extendedLock);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await service.extend(mockLock as any, 10000);
      expect(result).toBe(extendedLock);
      expect(mockExtend).toHaveBeenCalledWith(10000);
    });

    it('throws LockExtendException on failure', async () => {
      mockExtend.mockRejectedValueOnce(new Error('expired'));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(service.extend(mockLock as any, 5000)).rejects.toBeInstanceOf(
        LockExtendException,
      );
    });
  });

  describe('isLocked()', () => {
    it('returns false when resource is free (lock acquired and released)', async () => {
      const result = await service.isLocked('free-resource');
      expect(result).toBe(false);
      expect(mockRelease).toHaveBeenCalled();
    });

    it('returns true when resource is locked (acquire fails with ExecutionError)', async () => {
      const { ExecutionError } = jest.requireMock('redlock');
      mockAcquire.mockRejectedValueOnce(new ExecutionError('locked', []));
      const result = await service.isLocked('busy-resource');
      expect(result).toBe(true);
    });
  });

  describe('onModuleDestroy()', () => {
    it('calls redlock.quit()', async () => {
      await service.onModuleDestroy();
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildKey() (verified via public methods)', () => {
    it('prefixes keys with keyPrefix', async () => {
      await service.withLock('payment', async () => null);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:payment'], expect.any(Number));
    });

    it('handles special characters in keys', async () => {
      await service.withLock('user:42/booking?slot=A&B', async () => null);
      expect(mockAcquire).toHaveBeenCalledWith(
        ['lock:user:42/booking?slot=A&B'],
        expect.any(Number),
      );
    });

    it('handles unicode characters in keys', async () => {
      await service.withLock('资源:付款', async () => null);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:资源:付款'], expect.any(Number));
    });
  });

  describe('withLock() — auto-extend', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('extends lock at half-TTL intervals when autoExtend is true', async () => {
      const extendedLock = { ...mockLock, extend: mockExtend };
      mockExtend.mockResolvedValue(extendedLock);

      let resolveCallback!: (v: string) => void;
      const callbackPromise = service.withLock(
        'long-job',
        () =>
          new Promise<string>((resolve) => {
            resolveCallback = resolve;
          }),
        1000,
        true,
      );

      // Let acquire resolve so the interval is registered
      await Promise.resolve();

      // Interval fires at ttl/2 = 500ms; extend is called synchronously
      jest.advanceTimersByTime(501);
      expect(mockExtend).toHaveBeenCalledWith(1000);

      resolveCallback('done');
      const result = await callbackPromise;
      expect(result).toBe('done');
    });

    it('does not extend when autoExtend is false', async () => {
      const callbackPromise = service.withLock('quick-job', async () => 'done', 1000, false);
      await Promise.resolve();
      jest.advanceTimersByTime(1001);
      await callbackPromise;
      expect(mockExtend).not.toHaveBeenCalled();
    });

    it('does not extend when autoExtend is undefined', async () => {
      const callbackPromise = service.withLock('quick-job', async () => 'done', 1000);
      await Promise.resolve();
      jest.advanceTimersByTime(1001);
      await callbackPromise;
      expect(mockExtend).not.toHaveBeenCalled();
    });

    it('clears interval in finally so no extends occur after callback completes', async () => {
      const extendedLock = { ...mockLock, extend: mockExtend };
      mockExtend.mockResolvedValue(extendedLock);

      // Callback resolves immediately — withLock finishes before any interval fires
      const callbackPromise = service.withLock('short-job', async () => 'done', 1000, true);
      await callbackPromise;

      const callsAtCompletion = mockExtend.mock.calls.length;
      jest.advanceTimersByTime(2000);
      expect(mockExtend.mock.calls.length).toBe(callsAtCompletion);
    });

    it('clears interval in finally even when callback throws', async () => {
      const extendedLock = { ...mockLock, extend: mockExtend };
      mockExtend.mockResolvedValue(extendedLock);

      const callbackPromise = service.withLock(
        'fail-job',
        async () => {
          throw new Error('oops');
        },
        1000,
        true,
      );
      await expect(callbackPromise).rejects.toThrow('oops');

      const callsAtReject = mockExtend.mock.calls.length;
      jest.advanceTimersByTime(2000);
      expect(mockExtend.mock.calls.length).toBe(callsAtReject);
    });

    it('stops further extends and logs warning when extend call fails', async () => {
      mockExtend.mockRejectedValue(new Error('lock expired'));

      let resolveCallback!: (v: string) => void;
      const callbackPromise = service.withLock(
        'expiry-job',
        () =>
          new Promise<string>((resolve) => {
            resolveCallback = resolve;
          }),
        200, // interval fires at 100ms
        true,
      );

      // Let acquire complete and interval be registered
      await Promise.resolve();

      // First extend fires at 100ms — synchronously calls mockExtend
      jest.advanceTimersByTime(101);
      expect(mockExtend).toHaveBeenCalledTimes(1);

      // Flush the Promise rejection chain so .catch() runs and clears the interval
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the next interval boundary — should NOT fire again
      jest.advanceTimersByTime(300);
      expect(mockExtend).toHaveBeenCalledTimes(1);

      resolveCallback('ok');
      const result = await callbackPromise;
      expect(result).toBe('ok');
    });
  });

  describe('edge cases', () => {
    it('handles onModuleDestroy when redlock.quit() throws', async () => {
      mockQuit.mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('concurrent withLock calls all acquire independently', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => service.withLock(`resource-${i}`, async () => i)),
      );
      expect(results).toHaveLength(50);
      expect(mockAcquire).toHaveBeenCalledTimes(50);
      expect(mockRelease).toHaveBeenCalledTimes(50);
    });

    it('concurrent withLock on same resource all acquire (mock does not block)', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => service.withLock('shared-resource', async () => 'ok')),
      );
      expect(results.every((r) => r === 'ok')).toBe(true);
    });

    it('returns callback result even when release fails', async () => {
      mockRelease.mockRejectedValueOnce(new Error('redis disconnect during release'));
      const result = await service.withLock('res', async () => 42);
      expect(result).toBe(42);
    });

    it('withLock propagates callback error after releasing lock', async () => {
      const callbackErr = new Error('business logic failed');
      await expect(
        service.withLock('res', async () => {
          throw callbackErr;
        }),
      ).rejects.toBe(callbackErr);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('events (EventEmitter)', () => {
    it('emits ACQUIRED event with resource and ttl on successful withLock', async () => {
      const handler = jest.fn();
      service.on(LockEvent.ACQUIRED, handler);
      await service.withLock('pay', async () => 'ok', 3000);
      expect(handler).toHaveBeenCalledWith('pay', 3000);
    });

    it('emits RELEASED event with resource and heldForMs on successful withLock', async () => {
      const handler = jest.fn();
      service.on(LockEvent.RELEASED, handler);
      await service.withLock('pay', async () => 'ok', 3000);
      expect(handler).toHaveBeenCalledWith('pay', expect.any(Number));
    });

    it('emits FAILED event with resource and reason when acquire fails', async () => {
      mockAcquire.mockRejectedValueOnce(new Error('busy'));
      const handler = jest.fn();
      service.on(LockEvent.FAILED, handler);
      await service.withLock('pay', async () => 'x').catch(() => null);
      expect(handler).toHaveBeenCalledWith('pay', expect.stringContaining('busy'));
    });

    it('emits EXTENDED event from extend() method', async () => {
      const extendedLock = { ...mockLock, expiration: Date.now() + 10000 };
      mockExtend.mockResolvedValueOnce(extendedLock);
      const handler = jest.fn();
      service.on(LockEvent.EXTENDED, handler);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await service.extend(mockLock as any, 10000);
      expect(handler).toHaveBeenCalledWith(mockLock.resources[0], 10000);
    });

    it('does not emit RELEASED when lock is not acquired', async () => {
      mockAcquire.mockRejectedValueOnce(new Error('busy'));
      const handler = jest.fn();
      service.on(LockEvent.RELEASED, handler);
      await service.withLock('pay', async () => 'x').catch(() => null);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('lock groups (string[] resource)', () => {
    it('acquires all resources in sorted order', async () => {
      await service.withLock(['beta', 'alpha'], async () => 'ok');
      expect(mockAcquire).toHaveBeenCalledWith(
        ['lock:alpha', 'lock:beta'],
        expect.any(Number),
      );
    });

    it('returns callback result for group lock', async () => {
      const result = await service.withLock(['a', 'b'], async () => 'group-result');
      expect(result).toBe('group-result');
    });

    it('releases group lock in finally even when callback throws', async () => {
      await expect(
        service.withLock(['a', 'b'], async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('throws LockAcquisitionException when group acquisition fails', async () => {
      mockAcquire.mockRejectedValueOnce(new Error('locked'));
      await expect(service.withLock(['x', 'y'], async () => 'ok')).rejects.toBeInstanceOf(
        LockAcquisitionException,
      );
    });

    it('sorts resources to prevent deadlock regardless of input order', async () => {
      await service.withLock(['z', 'a', 'm'], async () => null);
      expect(mockAcquire).toHaveBeenCalledWith(
        ['lock:a', 'lock:m', 'lock:z'],
        expect.any(Number),
      );
    });

    it('emits ACQUIRED with sorted resource label', async () => {
      const handler = jest.fn();
      service.on(LockEvent.ACQUIRED, handler);
      await service.withLock(['beta', 'alpha'], async () => null, 2000);
      expect(handler).toHaveBeenCalledWith('alpha,beta', 2000);
    });

    it('emits RELEASED with sorted resource label', async () => {
      const handler = jest.fn();
      service.on(LockEvent.RELEASED, handler);
      await service.withLock(['beta', 'alpha'], async () => null);
      expect(handler).toHaveBeenCalledWith('alpha,beta', expect.any(Number));
    });
  });

  describe('queued locking (queue: true)', () => {
    it('initializes queue via Lua eval', async () => {
      await service.withLock('res', async () => 'ok', 1000, false, true);
      expect(mockEval).toHaveBeenCalledWith(expect.stringContaining('RPUSH'), 1, 'lock:res:queue');
    });

    it('acquires lock via BRPOP', async () => {
      await service.withLock('res', async () => 'ok', 1000, false, true);
      expect(mockBrpop).toHaveBeenCalledWith('lock:res:queue', expect.any(Number));
    });

    it('returns token via RPUSH after callback completes', async () => {
      await service.withLock('res', async () => 'ok', 1000, false, true);
      expect(mockRpush).toHaveBeenCalledWith('lock:res:queue', '1');
    });

    it('returns callback result', async () => {
      const result = await service.withLock('res', async () => 42, 1000, false, true);
      expect(result).toBe(42);
    });

    it('returns token even when callback throws', async () => {
      await expect(
        service.withLock(
          'res',
          async () => {
            throw new Error('boom');
          },
          1000,
          false,
          true,
        ),
      ).rejects.toThrow('boom');
      expect(mockRpush).toHaveBeenCalledWith('lock:res:queue', '1');
    });

    it('throws LockAcquisitionException when BRPOP times out (returns null)', async () => {
      mockBrpop.mockResolvedValueOnce(null);
      await expect(
        service.withLock('res', async () => 'ok', 1000, false, true),
      ).rejects.toBeInstanceOf(LockAcquisitionException);
    });

    it('emits ACQUIRED and RELEASED events for queued lock', async () => {
      const acquired = jest.fn();
      const released = jest.fn();
      service.on(LockEvent.ACQUIRED, acquired);
      service.on(LockEvent.RELEASED, released);

      await service.withLock('res', async () => null, 1000, false, true);

      expect(acquired).toHaveBeenCalledWith('res', 1000);
      expect(released).toHaveBeenCalledWith('res', expect.any(Number));
    });

    it('emits FAILED event when BRPOP times out', async () => {
      mockBrpop.mockResolvedValueOnce(null);
      const handler = jest.fn();
      service.on(LockEvent.FAILED, handler);
      await service.withLock('res', async () => null, 1000, false, true).catch(() => null);
      expect(handler).toHaveBeenCalledWith('res', expect.stringContaining('timeout'));
    });
  });
});
