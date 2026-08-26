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
    constructor(
      message: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Drains the microtask queue enough times for a promise chain of a few
 * `.then()`/`await` hops (acquire → handle adapter → fencing token INCR) to
 * fully settle, without hard-coding an exact tick count that would break
 * again the next time an intermediate `await` is added or removed.
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/**
 * Builds a redlock ExecutionError whose final attempt voted against for the
 * given reasons — the shape LockService inspects to tell contention apart
 * from an unreachable Redis.
 */
function executionError(votesAgainst: Error[]) {
  const { ExecutionError } = jest.requireMock('redlock');
  const stats = {
    membershipSize: 1,
    quorumSize: 1,
    votesFor: new Set(),
    votesAgainst: new Map(votesAgainst.map((err, i) => [`client-${i}`, err])),
  };
  return new ExecutionError('The operation was unable to achieve a quorum', [
    Promise.resolve(stats),
  ]);
}

describe('LockService', () => {
  let service: LockService;

  const mockZadd = jest.fn().mockResolvedValue(1);
  const mockZrem = jest.fn().mockResolvedValue(1);
  const mockZrange = jest.fn();
  const mockZrank = jest.fn().mockResolvedValue(0);
  const mockIncr = jest.fn().mockResolvedValue(1);
  const mockExists = jest.fn().mockResolvedValue(0);
  const mockSemaphoreAcquire = jest.fn().mockResolvedValue(1);
  const mockSemaphoreExtend = jest.fn().mockResolvedValue(1);
  const mockRwAcquireRead = jest.fn().mockResolvedValue(1);
  const mockRwAcquireWrite = jest.fn().mockResolvedValue(1);
  const mockRwExtendWrite = jest.fn().mockResolvedValue(1);
  const mockRwReleaseWrite = jest.fn().mockResolvedValue(1);
  const mockSet = jest.fn().mockResolvedValue('OK');
  const mockDel = jest.fn().mockResolvedValue(1);
  const mockPexpire = jest.fn().mockResolvedValue(1);

  const mockOptions = {
    clients: [
      {
        zadd: mockZadd,
        zrem: mockZrem,
        zrange: mockZrange,
        zrank: mockZrank,
        incr: mockIncr,
        exists: mockExists,
        semaphoreAcquire: mockSemaphoreAcquire,
        semaphoreExtend: mockSemaphoreExtend,
        rwAcquireRead: mockRwAcquireRead,
        rwAcquireWrite: mockRwAcquireWrite,
        rwExtendWrite: mockRwExtendWrite,
        rwReleaseWrite: mockRwReleaseWrite,
        set: mockSet,
        del: mockDel,
        pexpire: mockPexpire,
      },
    ],
    duration: 5000,
    retryCount: 3,
    retryDelay: 200,
    retryJitter: 100,
    driftFactor: 0.01,
    keyPrefix: 'lock',
  };

  /** Makes the caller the head of the queue on every poll. */
  const beHeadOfQueue = () =>
    mockZrange.mockImplementation(async () => [mockZadd.mock.calls.at(-1)?.[3]]);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAcquire.mockResolvedValue(mockLock);
    mockRelease.mockResolvedValue(undefined);
    mockZadd.mockResolvedValue(1);
    mockZrem.mockResolvedValue(1);
    mockZrank.mockResolvedValue(0);
    mockIncr.mockResolvedValue(1);
    mockExists.mockResolvedValue(0);
    mockSemaphoreAcquire.mockResolvedValue(1);
    mockSemaphoreExtend.mockResolvedValue(1);
    mockRwAcquireRead.mockResolvedValue(1);
    mockRwAcquireWrite.mockResolvedValue(1);
    mockRwExtendWrite.mockResolvedValue(1);
    mockRwReleaseWrite.mockResolvedValue(1);
    mockSet.mockResolvedValue('OK');
    mockDel.mockResolvedValue(1);
    mockPexpire.mockResolvedValue(1);
    beHeadOfQueue();

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

    it('returns null when the resource is genuinely held', async () => {
      mockAcquire.mockRejectedValueOnce(executionError([new Error('resource is locked')]));
      const lock = await service.tryLock('res');
      expect(lock).toBeNull();
    });

    it('returns null when ResourceLockedError is thrown', async () => {
      const { ResourceLockedError } = jest.requireMock('redlock');
      mockAcquire.mockRejectedValueOnce(new ResourceLockedError('locked'));
      const lock = await service.tryLock('res');
      expect(lock).toBeNull();
    });

    // Redlock reports "held by someone else" and "Redis is down" as the same
    // ExecutionError. Conflating them made the health check permanently green.
    it('re-throws when the quorum failed because Redis is unreachable', async () => {
      const connErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
        code: 'ECONNREFUSED',
      });
      const { ExecutionError } = jest.requireMock('redlock');
      mockAcquire.mockRejectedValueOnce(executionError([connErr]));
      await expect(service.tryLock('res')).rejects.toBeInstanceOf(ExecutionError);
    });

    it('re-throws when a connection is closed mid-flight', async () => {
      const { ExecutionError } = jest.requireMock('redlock');
      mockAcquire.mockRejectedValueOnce(executionError([new Error('Connection is closed.')]));
      await expect(service.tryLock('res')).rejects.toBeInstanceOf(ExecutionError);
    });

    it('re-throws an ExecutionError carrying no votes (never reached the nodes)', async () => {
      const { ExecutionError } = jest.requireMock('redlock');
      await expect(async () => {
        mockAcquire.mockRejectedValueOnce(new ExecutionError('fail', []));
        await service.tryLock('res');
      }).rejects.toBeInstanceOf(ExecutionError);
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

  describe('fencing tokens', () => {
    it('passes an increasing fencing token to the callback on each acquisition', async () => {
      mockIncr.mockResolvedValueOnce(7).mockResolvedValueOnce(8);

      const first = await service.withLock('sku-42', async (_signal, token) => token);
      const second = await service.withLock('sku-42', async (_signal, token) => token);

      expect(first).toBe(7);
      expect(second).toBe(8);
      expect(mockIncr).toHaveBeenCalledWith('lock:sku-42:fence');
    });

    it('tryLockWithToken returns the lock plus a fencing token', async () => {
      mockIncr.mockResolvedValueOnce(3);
      const result = await service.tryLockWithToken('sku-42', 5000);
      expect(result).toEqual({ lock: mockLock, fencingToken: 3 });
    });

    it('tryLockWithToken returns null on contention without issuing a token', async () => {
      mockAcquire.mockRejectedValueOnce(executionError([new Error('resource is locked')]));
      const result = await service.tryLockWithToken('sku-42');
      expect(result).toBeNull();
      expect(mockIncr).not.toHaveBeenCalled();
    });

    it('never refreshes the fence counter TTL by default (pre-1.3.0 behavior)', async () => {
      await service.withLock('sku-42', async (_signal, token) => token);
      expect(mockPexpire).not.toHaveBeenCalled();
    });

    it('refreshes the fence counter TTL on every acquisition when fenceCounterIdleTtl is set', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LockService,
          {
            provide: LOCK_MODULE_OPTIONS,
            useValue: { ...mockOptions, fenceCounterIdleTtl: 30_000 },
          },
        ],
      }).compile();
      const idleTtlService = module.get<LockService>(LockService);

      await idleTtlService.withLock('sku-42', async (_signal, token) => token);

      expect(mockPexpire).toHaveBeenCalledWith('lock:sku-42:fence', 30_000);
    });
  });

  describe('AbortSignal', () => {
    it('provides a signal that is not aborted for a healthy lock', async () => {
      let seen: AbortSignal | undefined;
      await service.withLock('res', async (signal) => {
        seen = signal;
      });
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen!.aborted).toBe(false);
    });

    it('aborts the signal when auto-extend fails', async () => {
      jest.useFakeTimers();
      mockExtend.mockRejectedValue(new Error('lock expired'));

      let signal!: AbortSignal;
      let resolveCallback!: (v: string) => void;
      const callbackPromise = service.withLock(
        'expiry-job',
        (s) =>
          new Promise<string>((resolve) => {
            signal = s;
            resolveCallback = resolve;
          }),
        200,
        true,
      );

      await flushMicrotasks();
      jest.advanceTimersByTime(101);
      await flushMicrotasks();

      expect(signal.aborted).toBe(true);

      resolveCallback('done');
      await callbackPromise;
      jest.useRealTimers();
    });
  });

  describe('isLocked()', () => {
    it('returns false when the key does not exist', async () => {
      mockExists.mockResolvedValueOnce(0);
      expect(await service.isLocked('free-resource')).toBe(false);
      expect(mockExists).toHaveBeenCalledWith('lock:free-resource');
    });

    it('returns true when the key exists', async () => {
      mockExists.mockResolvedValueOnce(1);
      expect(await service.isLocked('busy-resource')).toBe(true);
    });

    // It used to probe by acquiring a real 1ms lock, which could deny a
    // legitimate acquirer and blocked for the full retry budget.
    it('is read-only — never acquires or releases a lock', async () => {
      await service.isLocked('some-resource');
      expect(mockAcquire).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy()', () => {
    // The clients belong to the caller and may be shared with the rest of
    // their app — shutting down the lock module must not close them.
    it('leaves the caller’s Redis clients open by default', async () => {
      await service.onModuleDestroy();
      expect(mockQuit).not.toHaveBeenCalled();
    });

    it('closes them when closeClientsOnDestroy is enabled', async () => {
      const owned = (
        await Test.createTestingModule({
          providers: [
            LockService,
            {
              provide: LOCK_MODULE_OPTIONS,
              useValue: { ...mockOptions, closeClientsOnDestroy: true },
            },
          ],
        }).compile()
      ).get(LockService);

      await owned.onModuleDestroy();
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });
  });

  describe('maxListeners', () => {
    it('defaults to 10 (Node’s own default) when unset', () => {
      expect(service.getMaxListeners()).toBe(10);
    });

    it('applies the configured value when set', async () => {
      const withCustomMax = (
        await Test.createTestingModule({
          providers: [
            LockService,
            { provide: LOCK_MODULE_OPTIONS, useValue: { ...mockOptions, maxListeners: 20 } },
          ],
        }).compile()
      ).get(LockService);

      expect(withCustomMax.getMaxListeners()).toBe(20);
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

      // Let acquire resolve, the interval register, and the callback (gated
      // on the fencing token INCR) actually start running.
      await flushMicrotasks();

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

      // Let acquire complete, the interval register, and the callback (gated
      // on the fencing token INCR) actually start running.
      await flushMicrotasks();

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
      const owned = (
        await Test.createTestingModule({
          providers: [
            LockService,
            {
              provide: LOCK_MODULE_OPTIONS,
              useValue: { ...mockOptions, closeClientsOnDestroy: true },
            },
          ],
        }).compile()
      ).get(LockService);

      await expect(owned.onModuleDestroy()).resolves.toBeUndefined();
      expect(mockQuit).toHaveBeenCalledTimes(1);
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

    it('once() fires the typed listener exactly once', async () => {
      const handler = jest.fn();
      service.once(LockEvent.ACQUIRED, handler);
      await service.withLock('pay', async () => null, 1000);
      await service.withLock('pay', async () => null, 1000);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits EXTEND_FAILED when auto-extend fails mid-callback', async () => {
      jest.useFakeTimers();
      mockExtend.mockRejectedValue(new Error('lock expired'));
      const handler = jest.fn();
      service.on(LockEvent.EXTEND_FAILED, handler);

      let resolveCallback!: (v: string) => void;
      const callbackPromise = service.withLock(
        'expiry-job',
        () =>
          new Promise<string>((resolve) => {
            resolveCallback = resolve;
          }),
        200,
        true,
      );

      await flushMicrotasks();
      jest.advanceTimersByTime(101);
      await flushMicrotasks();

      expect(handler).toHaveBeenCalledWith('expiry-job', expect.stringContaining('lock expired'));

      resolveCallback('done');
      await callbackPromise;
      jest.useRealTimers();
    });

    it('emits RELEASE_FAILED when release fails after the callback completes', async () => {
      mockRelease.mockRejectedValueOnce(new Error('release failed'));
      const handler = jest.fn();
      service.on(LockEvent.RELEASE_FAILED, handler);
      await service.withLock('res', async () => 'value');
      expect(handler).toHaveBeenCalledWith('res', expect.stringContaining('release failed'));
    });
  });

  describe('lock groups (string[] resource)', () => {
    it('acquires all resources in sorted order', async () => {
      await service.withLock(['beta', 'alpha'], async () => 'ok');
      expect(mockAcquire).toHaveBeenCalledWith(['lock:alpha', 'lock:beta'], expect.any(Number));
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
      expect(mockAcquire).toHaveBeenCalledWith(['lock:a', 'lock:m', 'lock:z'], expect.any(Number));
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
    // Ordering must come from arrival, not from the caller's deadline —
    // otherwise a short queueTimeout would jump ahead of an earlier caller.
    it('takes a monotonic sequence number and joins the queue with it', async () => {
      mockIncr.mockResolvedValueOnce(7);
      await service.withLock('res', async () => 'ok', { duration: 1000, queue: true });

      expect(mockIncr).toHaveBeenCalledWith('lock:res:seq');
      expect(mockZadd).toHaveBeenCalledWith('lock:res:queue', 'NX', 7, expect.any(String));
    });

    it('carries each waiter’s own deadline inside its queue member', async () => {
      await service.withLock('res', async () => 'ok', {
        duration: 1000,
        queue: true,
        queueTimeout: 4000,
      });

      const member: string = mockZadd.mock.calls[0][3];
      const [deadline, ticket] = member.split('|');
      expect(Number(deadline)).toBeGreaterThan(Date.now());
      expect(ticket).toHaveLength(36); // uuid
    });

    // The whole point of the redesign: the queue only orders callers.
    // Mutual exclusion must still come from a real, TTL-backed lock.
    it('acquires the real Redlock lock once it reaches the head of the queue', async () => {
      await service.withLock('res', async () => 'ok', { duration: 1000, queue: true });
      expect(mockAcquire).toHaveBeenCalledWith(['lock:res'], 1000);
      expect(mockRelease).toHaveBeenCalled();
    });

    // A crashed waiter must not block the line behind it.
    it('evicts expired waiters found at the head, then proceeds', async () => {
      const expired = `${Date.now() - 5000}|dead-waiter`;
      mockZrange.mockImplementation(async () => [
        expired,
        mockZadd.mock.calls.at(-1)?.[3] as string,
      ]);

      const result = await service.withLock('res', async () => 'ok', {
        duration: 1000,
        queue: true,
      });

      expect(mockZrem).toHaveBeenCalledWith('lock:res:queue', expired);
      expect(result).toBe('ok');
    });

    it('waits while another ticket is at the head, then proceeds', async () => {
      mockZrange
        .mockResolvedValueOnce(['someone-else'])
        .mockResolvedValueOnce(['someone-else'])
        .mockImplementation(async () => [mockZadd.mock.calls.at(-1)?.[3]]);

      const result = await service.withLock('res', async () => 'ok', {
        duration: 1000,
        queue: true,
      });

      expect(result).toBe('ok');
      expect(mockZrange).toHaveBeenCalledTimes(3);
      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });

    it('returns callback result', async () => {
      const result = await service.withLock('res', async () => 42, { duration: 1000, queue: true });
      expect(result).toBe(42);
    });

    it('leaves the queue even when the callback throws', async () => {
      await expect(
        service.withLock(
          'res',
          async () => {
            throw new Error('boom');
          },
          { duration: 1000, queue: true },
        ),
      ).rejects.toThrow('boom');
      expect(mockZrem).toHaveBeenCalledWith('lock:res:queue', expect.any(String));
    });

    it('leaves the queue after a successful run', async () => {
      await service.withLock('res', async () => 'ok', { duration: 1000, queue: true });
      expect(mockZrem).toHaveBeenCalledWith('lock:res:queue', expect.any(String));
    });

    it('throws LockAcquisitionException when the queue wait exceeds queueTimeout', async () => {
      mockZrange.mockResolvedValue(['someone-else-forever']);
      await expect(
        service.withLock('res', async () => 'ok', {
          duration: 1000,
          queue: true,
          queueTimeout: 60,
        }),
      ).rejects.toBeInstanceOf(LockAcquisitionException);
    });

    it('emits FAILED when the queue wait times out', async () => {
      mockZrange.mockResolvedValue(['someone-else-forever']);
      const handler = jest.fn();
      service.on(LockEvent.FAILED, handler);
      await service
        .withLock('res', async () => null, { duration: 1000, queue: true, queueTimeout: 60 })
        .catch(() => null);
      expect(handler).toHaveBeenCalledWith('res', expect.stringContaining('timeout'));
    });

    it('emits ACQUIRED and RELEASED events for queued lock', async () => {
      const acquired = jest.fn();
      const released = jest.fn();
      service.on(LockEvent.ACQUIRED, acquired);
      service.on(LockEvent.RELEASED, released);

      await service.withLock('res', async () => null, { duration: 1000, queue: true });

      expect(acquired).toHaveBeenCalledWith('res', 1000);
      expect(released).toHaveBeenCalledWith('res', expect.any(Number));
    });

    it('emits QUEUED with a 1-based queue position on entry', async () => {
      mockZrank.mockResolvedValueOnce(2);
      const handler = jest.fn();
      service.on(LockEvent.QUEUED, handler);

      await service.withLock('res', async () => null, { duration: 1000, queue: true });

      expect(handler).toHaveBeenCalledWith('res', 3);
    });

    it('re-joins the queue if its ticket was evicted while polling', async () => {
      mockZrange
        .mockResolvedValueOnce([])
        .mockImplementation(async () => [mockZadd.mock.calls.at(-1)?.[3]]);

      await service.withLock('res', async () => 'ok', { duration: 1000, queue: true });
      expect(mockZadd).toHaveBeenCalledTimes(2);
    });

    // Silently ignoring the flag is how the old code hid this case.
    it('rejects queue: true for lock groups instead of ignoring it', async () => {
      await expect(service.withLock(['a', 'b'], async () => 'ok', { queue: true })).rejects.toThrow(
        'not supported for lock groups',
      );
    });

    it('admittedSet pages past a run of expired entries to find the live one', async () => {
      // First page (10 entries, all already expired) gets fully evicted;
      // admittedSet must continue to a second page instead of giving up.
      const expiredPage = Array.from({ length: 10 }, (_, i) => `1|expired-${i}`);
      mockZrange
        .mockResolvedValueOnce(expiredPage)
        .mockImplementation(async () => [mockZadd.mock.calls.at(-1)?.[3]]);

      const result = await service.withLock('res', async () => 'ok', {
        duration: 1000,
        queue: true,
      });

      expect(result).toBe('ok');
      expect(mockZrange).toHaveBeenCalledTimes(2);
      expect(mockZrem).toHaveBeenCalledTimes(10 + 1); // 10 expired entries + our own cleanup
    });
  });

  describe('poll delay jitter (queue/semaphore/read-write busy-poll loops)', () => {
    // Intercepts the real setTimeout calls the poll loop makes, firing them
    // immediately (ms: 0) so the test stays fast while still recording the
    // jittered delay value the loop actually chose.
    function spyOnPollDelays(): { delays: number[]; restore: () => void } {
      const delays: number[] = [];
      const realSetTimeout = global.setTimeout;
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
        cb: () => void,
        ms?: number,
      ) => {
        if (ms !== undefined) {
          delays.push(ms);
        }
        return realSetTimeout(cb, 0);
      }) as unknown as typeof setTimeout);
      return { delays, restore: () => spy.mockRestore() };
    }

    it('randomizes each poll delay within [retryDelay, retryDelay + retryJitter)', async () => {
      mockZrange
        .mockResolvedValueOnce(['someone-else'])
        .mockResolvedValueOnce(['someone-else'])
        .mockResolvedValueOnce(['someone-else'])
        .mockImplementation(async () => [mockZadd.mock.calls.at(-1)?.[3]]);

      const { delays, restore } = spyOnPollDelays();
      try {
        await service.withLock('res', async () => 'ok', { duration: 1000, queue: true });
      } finally {
        restore();
      }

      expect(delays.length).toBeGreaterThanOrEqual(3);
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(mockOptions.retryDelay);
        expect(delay).toBeLessThan(mockOptions.retryDelay + mockOptions.retryJitter);
      }
      // With real randomness, 3+ identical draws in a row is effectively
      // impossible — this is what tells jitter apart from a fixed delay.
      expect(new Set(delays).size).toBeGreaterThan(1);
    });

    it('reproduces the old fixed-delay behavior exactly when retryJitter is 0', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LockService,
          {
            provide: LOCK_MODULE_OPTIONS,
            useValue: { ...mockOptions, retryJitter: 0 },
          },
        ],
      }).compile();
      const noJitterService = module.get<LockService>(LockService);

      mockZrange
        .mockResolvedValueOnce(['someone-else'])
        .mockResolvedValueOnce(['someone-else'])
        .mockImplementation(async () => [mockZadd.mock.calls.at(-1)?.[3]]);

      const { delays, restore } = spyOnPollDelays();
      try {
        await noJitterService.withLock('res', async () => 'ok', { duration: 1000, queue: true });
      } finally {
        restore();
      }

      expect(delays.length).toBeGreaterThanOrEqual(2);
      expect(new Set(delays)).toEqual(new Set([mockOptions.retryDelay]));
    });
  });

  describe('semaphore (maxConcurrent: N)', () => {
    it('acquires a slot immediately when admitted and semaphoreAcquire succeeds', async () => {
      const result = await service.withLock('pool', async () => 'ok', {
        duration: 1000,
        maxConcurrent: 3,
      });

      expect(result).toBe('ok');
      expect(mockSemaphoreAcquire).toHaveBeenCalledWith(
        'lock:pool:sem',
        expect.any(Number),
        expect.any(Number),
        3,
        expect.any(String),
      );
      expect(mockZrem).toHaveBeenCalledWith('lock:pool:sem:queue', expect.any(String));
    });

    it('retries without losing queue position when semaphoreAcquire reports the set still full', async () => {
      mockSemaphoreAcquire.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

      const result = await service.withLock('pool', async () => 'ok', {
        duration: 1000,
        maxConcurrent: 2,
      });

      expect(result).toBe('ok');
      expect(mockSemaphoreAcquire).toHaveBeenCalledTimes(2);
    });

    it('releases the slot via ZREM on the owners set, not a shared counter', async () => {
      await service.withLock('pool', async () => 'ok', { duration: 1000, maxConcurrent: 2 });
      expect(mockZrem).toHaveBeenCalledWith('lock:pool:sem', expect.any(String));
    });

    it('throws LockAcquisitionException when the semaphore wait exceeds queueTimeout', async () => {
      mockZrange.mockResolvedValue(['someone-else-forever']);
      await expect(
        service.withLock('pool', async () => 'ok', {
          duration: 1000,
          maxConcurrent: 2,
          queueTimeout: 60,
        }),
      ).rejects.toBeInstanceOf(LockAcquisitionException);
    });

    it('emits QUEUED, ACQUIRED, and RELEASED for a semaphore acquisition', async () => {
      const queued = jest.fn();
      const acquired = jest.fn();
      const released = jest.fn();
      service.on(LockEvent.QUEUED, queued);
      service.on(LockEvent.ACQUIRED, acquired);
      service.on(LockEvent.RELEASED, released);

      await service.withLock('pool', async () => null, { duration: 1000, maxConcurrent: 4 });

      expect(queued).toHaveBeenCalledWith('pool', expect.any(Number));
      expect(acquired).toHaveBeenCalledWith('pool', 1000);
      expect(released).toHaveBeenCalledWith('pool', expect.any(Number));
    });

    it('auto-extends via semaphoreExtend and aborts the signal if the slot was evicted', async () => {
      jest.useFakeTimers();
      mockSemaphoreExtend.mockResolvedValue(0); // "evicted" — not renewed

      let signal!: AbortSignal;
      let resolveCallback!: (v: string) => void;
      const callbackPromise = service.withLock(
        'pool',
        (s) =>
          new Promise<string>((resolve) => {
            signal = s;
            resolveCallback = resolve;
          }),
        { duration: 200, maxConcurrent: 2, autoExtend: true },
      );

      await flushMicrotasks();
      jest.advanceTimersByTime(101);
      await flushMicrotasks();

      expect(mockSemaphoreExtend).toHaveBeenCalledWith(
        'lock:pool:sem',
        expect.any(String),
        expect.any(Number),
      );
      expect(signal.aborted).toBe(true);

      resolveCallback('done');
      await callbackPromise;
      jest.useRealTimers();
    });

    it('rejects maxConcurrent for lock groups (array resources)', async () => {
      await expect(
        service.withLock(['a', 'b'], async () => 'ok', { maxConcurrent: 2 }),
      ).rejects.toThrow('not supported for lock groups');
    });

    it('rejects maxConcurrent combined with queue', async () => {
      await expect(
        service.withLock('res', async () => 'ok', { maxConcurrent: 2, queue: true }),
      ).rejects.toThrow('cannot be combined');
    });

    it.each([0, -1, 1.5])('rejects a non-positive-integer maxConcurrent (%p)', async (value) => {
      await expect(
        service.withLock('res', async () => 'ok', { maxConcurrent: value }),
      ).rejects.toThrow('positive integer');
    });
  });

  describe('read-write locks (mode: "read" | "write")', () => {
    describe('mode: "read"', () => {
      it('acquires immediately when rwAcquireRead admits it', async () => {
        const result = await service.withLock('doc', async () => 'ok', {
          duration: 1000,
          mode: 'read',
        });

        expect(result).toBe('ok');
        expect(mockRwAcquireRead).toHaveBeenCalledWith(
          'lock:doc:rw:readers',
          'lock:doc:rw:writer',
          'lock:doc:rw:writer-waiting',
          expect.any(Number),
          expect.any(Number),
          expect.any(String),
        );
      });

      it('retries while a writer holds or is waiting', async () => {
        mockRwAcquireRead.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

        const result = await service.withLock('doc', async () => 'ok', {
          duration: 1000,
          mode: 'read',
        });

        expect(result).toBe('ok');
        expect(mockRwAcquireRead).toHaveBeenCalledTimes(2);
      });

      it('releases via ZREM on the readers set', async () => {
        await service.withLock('doc', async () => 'ok', { duration: 1000, mode: 'read' });
        expect(mockZrem).toHaveBeenCalledWith('lock:doc:rw:readers', expect.any(String));
      });

      it('throws LockAcquisitionException when the wait exceeds queueTimeout', async () => {
        mockRwAcquireRead.mockResolvedValue(0);
        await expect(
          service.withLock('doc', async () => 'ok', {
            duration: 1000,
            mode: 'read',
            queueTimeout: 60,
          }),
        ).rejects.toBeInstanceOf(LockAcquisitionException);
      });

      it('multiple concurrent readers can all be admitted (no shared exclusion)', async () => {
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            service.withLock(`doc-${i}`, async () => i, { duration: 1000, mode: 'read' }),
          ),
        );
        expect(results).toEqual([0, 1, 2, 3, 4]);
      });
    });

    describe('mode: "write"', () => {
      it('sets the writer-waiting marker while contending, then acquires', async () => {
        const result = await service.withLock('doc', async () => 'ok', {
          duration: 1000,
          mode: 'write',
        });

        expect(result).toBe('ok');
        expect(mockSet).toHaveBeenCalledWith(
          'lock:doc:rw:writer-waiting',
          expect.any(String),
          'PX',
          expect.any(Number),
        );
        expect(mockRwAcquireWrite).toHaveBeenCalledWith(
          'lock:doc:rw:readers',
          'lock:doc:rw:writer',
          expect.any(Number),
          1000,
          expect.any(String),
        );
      });

      it('retries while readers are still draining', async () => {
        mockRwAcquireWrite.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

        const result = await service.withLock('doc', async () => 'ok', {
          duration: 1000,
          mode: 'write',
        });

        expect(result).toBe('ok');
        expect(mockRwAcquireWrite).toHaveBeenCalledTimes(2);
      });

      it('releases via a compare-and-delete on the writer key, and clears writer-waiting', async () => {
        await service.withLock('doc', async () => 'ok', { duration: 1000, mode: 'write' });
        expect(mockRwReleaseWrite).toHaveBeenCalledWith('lock:doc:rw:writer', expect.any(String));
        expect(mockDel).toHaveBeenCalledWith('lock:doc:rw:writer-waiting');
      });

      it('throws LockAcquisitionException when the wait exceeds queueTimeout', async () => {
        mockRwAcquireWrite.mockResolvedValue(0);
        await expect(
          service.withLock('doc', async () => 'ok', {
            duration: 1000,
            mode: 'write',
            queueTimeout: 60,
          }),
        ).rejects.toBeInstanceOf(LockAcquisitionException);
      });

      it('auto-extends via rwExtendWrite and aborts the signal if evicted', async () => {
        jest.useFakeTimers();
        mockRwExtendWrite.mockResolvedValue(0); // "evicted" — not renewed

        let signal!: AbortSignal;
        let resolveCallback!: (v: string) => void;
        const callbackPromise = service.withLock(
          'doc',
          (s) =>
            new Promise<string>((resolve) => {
              signal = s;
              resolveCallback = resolve;
            }),
          { duration: 200, mode: 'write', autoExtend: true },
        );

        await flushMicrotasks();
        jest.advanceTimersByTime(101);
        await flushMicrotasks();

        expect(mockRwExtendWrite).toHaveBeenCalledWith(
          'lock:doc:rw:writer',
          expect.any(String),
          200,
        );
        expect(signal.aborted).toBe(true);

        resolveCallback('done');
        await callbackPromise;
        jest.useRealTimers();
      });
    });

    describe('validation', () => {
      it('rejects mode for lock groups (array resources)', async () => {
        await expect(
          service.withLock(['a', 'b'], async () => 'ok', { mode: 'read' }),
        ).rejects.toThrow('not supported for lock groups');
      });

      it('rejects mode combined with queue', async () => {
        await expect(
          service.withLock('res', async () => 'ok', { mode: 'read', queue: true }),
        ).rejects.toThrow('cannot be combined');
      });

      it('rejects mode combined with maxConcurrent', async () => {
        await expect(
          service.withLock('res', async () => 'ok', { mode: 'write', maxConcurrent: 2 }),
        ).rejects.toThrow('cannot be combined');
      });
    });
  });

  describe('withLock() — options object vs positional', () => {
    it('accepts the options object form', async () => {
      await service.withLock('res', async () => null, { duration: 7000 });
      expect(mockAcquire).toHaveBeenCalledWith(['lock:res'], 7000);
    });

    it('still accepts the deprecated positional form', async () => {
      await service.withLock('res', async () => null, 7000);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:res'], 7000);
    });

    it('falls back to the module default duration', async () => {
      await service.withLock('res', async () => null);
      expect(mockAcquire).toHaveBeenCalledWith(['lock:res'], 5000);
    });
  });
});

describe('LockService — Lua command registration (semaphore + read-write lock)', () => {
  it('defines the semaphore and read-write lock commands on a client that supports defineCommand', async () => {
    const defineCommand = jest.fn();
    const client = { defineCommand, zadd: jest.fn(), zrem: jest.fn(), zrange: jest.fn() };

    await Test.createTestingModule({
      providers: [
        LockService,
        {
          provide: LOCK_MODULE_OPTIONS,
          useValue: { clients: [client], keyPrefix: 'lock' },
        },
      ],
    }).compile();

    expect(defineCommand).toHaveBeenCalledWith(
      'semaphoreAcquire',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
    expect(defineCommand).toHaveBeenCalledWith(
      'semaphoreExtend',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
    expect(defineCommand).toHaveBeenCalledWith(
      'rwAcquireRead',
      expect.objectContaining({ numberOfKeys: 3 }),
    );
    expect(defineCommand).toHaveBeenCalledWith(
      'rwAcquireWrite',
      expect.objectContaining({ numberOfKeys: 2 }),
    );
    expect(defineCommand).toHaveBeenCalledWith(
      'rwExtendWrite',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
    expect(defineCommand).toHaveBeenCalledWith(
      'rwReleaseWrite',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
  });

  it('does not redefine commands the client already has', async () => {
    const defineCommand = jest.fn();
    const client = {
      defineCommand,
      semaphoreAcquire: jest.fn(),
      semaphoreExtend: jest.fn(),
      rwAcquireRead: jest.fn(),
      rwAcquireWrite: jest.fn(),
      rwExtendWrite: jest.fn(),
      rwReleaseWrite: jest.fn(),
      zadd: jest.fn(),
      zrem: jest.fn(),
      zrange: jest.fn(),
    };

    await Test.createTestingModule({
      providers: [
        LockService,
        {
          provide: LOCK_MODULE_OPTIONS,
          useValue: { clients: [client], keyPrefix: 'lock' },
        },
      ],
    }).compile();

    expect(defineCommand).not.toHaveBeenCalled();
  });

  it('skips registration entirely on a client without defineCommand (e.g. a plain test mock)', async () => {
    const client = { zadd: jest.fn(), zrem: jest.fn(), zrange: jest.fn() };

    await expect(
      Test.createTestingModule({
        providers: [
          LockService,
          {
            provide: LOCK_MODULE_OPTIONS,
            useValue: { clients: [client], keyPrefix: 'lock' },
          },
        ],
      }).compile(),
    ).resolves.toBeDefined();
  });
});
