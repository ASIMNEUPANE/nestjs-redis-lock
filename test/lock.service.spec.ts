import { Test, TestingModule } from '@nestjs/testing';
import { LockService } from '../src/lock.service';
import { LOCK_MODULE_OPTIONS } from '../src/constants';
import { LockAcquisitionException } from '../src/exceptions/lock-acquisition.exception';
import { LockExtendException } from '../src/exceptions/lock-extend.exception';

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

  const mockOptions = {
    clients: [{}],
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
  });
});
