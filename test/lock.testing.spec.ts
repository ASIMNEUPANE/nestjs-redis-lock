import { Test, TestingModule } from '@nestjs/testing';
import { FakeLockService } from '../src/testing';
import { LockAcquisitionException } from '../src/exceptions/lock-acquisition.exception';

describe('FakeLockService', () => {
  let fake: FakeLockService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FakeLockService],
    }).compile();

    fake = module.get(FakeLockService);
  });

  describe('withLock()', () => {
    it('runs the callback and returns its result', async () => {
      const result = await fake.withLock('res', async () => 'value');
      expect(result).toBe('value');
    });

    it('works with a string[] resource (lock groups)', async () => {
      const result = await fake.withLock(['a', 'b'], async () => 'group');
      expect(result).toBe('group');
    });

    it('propagates callback errors without wrapping', async () => {
      const err = new Error('business error');
      await expect(
        fake.withLock('res', async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    });

    it('ignores duration, autoExtend, and queue options', async () => {
      const result = await fake.withLock('res', async () => 42, 10000, true, true);
      expect(result).toBe(42);
    });

    it('passes an AbortSignal and an increasing fencing token to the callback', async () => {
      const first = await fake.withLock('res', async (signal, token) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        return token;
      });
      const second = await fake.withLock('res', async (_signal, token) => token);

      expect(second).toBe(first + 1);
    });

    it('throws LockAcquisitionException when the resource is simulateLocked', async () => {
      fake.simulateLocked('res');
      await expect(fake.withLock('res', async () => 'value')).rejects.toBeInstanceOf(
        LockAcquisitionException,
      );
    });

    it('throws when any member of a lock group is simulateLocked', async () => {
      fake.simulateLocked('b');
      await expect(fake.withLock(['a', 'b'], async () => 'group')).rejects.toBeInstanceOf(
        LockAcquisitionException,
      );
    });

    it('succeeds again after simulateUnlocked', async () => {
      fake.simulateLocked('res');
      fake.simulateUnlocked('res');
      const result = await fake.withLock('res', async () => 'value');
      expect(result).toBe('value');
    });

    it('succeeds again after simulateAllUnlocked', async () => {
      fake.simulateLocked('a');
      fake.simulateLocked('b');
      fake.simulateAllUnlocked();
      const result = await fake.withLock('a', async () => 'value');
      expect(result).toBe('value');
    });
  });

  describe('tryLock()', () => {
    it('returns a lock without needing Redis', async () => {
      const lock = await fake.tryLock('res');
      expect(lock).not.toBeNull();
    });

    it('returns null once the resource is simulateLocked', async () => {
      fake.simulateLocked('res');
      const lock = await fake.tryLock('res', 9000);
      expect(lock).toBeNull();
    });
  });

  describe('tryLockWithToken()', () => {
    it('returns a lock and an increasing fencing token', async () => {
      const first = await fake.tryLockWithToken('res');
      const second = await fake.tryLockWithToken('res');
      expect(first).not.toBeNull();
      expect(second!.fencingToken).toBe(first!.fencingToken + 1);
    });

    it('returns null once the resource is simulateLocked', async () => {
      fake.simulateLocked('res');
      expect(await fake.tryLockWithToken('res')).toBeNull();
    });
  });

  describe('extend()', () => {
    it('returns the same lock unchanged', async () => {
      const mockLock = { resources: ['lock:res'] } as never;
      const result = await fake.extend(mockLock, 5000);
      expect(result).toBe(mockLock);
    });
  });

  describe('isLocked()', () => {
    it('returns false by default', async () => {
      const locked = await fake.isLocked('res');
      expect(locked).toBe(false);
    });

    it('reflects simulateLocked/simulateUnlocked', async () => {
      fake.simulateLocked('res');
      expect(await fake.isLocked('res')).toBe(true);
      fake.simulateUnlocked('res');
      expect(await fake.isLocked('res')).toBe(false);
    });
  });

  describe('call recording', () => {
    it('records withLock/tryLock/tryLockWithToken calls in order', async () => {
      await fake.withLock('a', async () => null);
      await fake.tryLock('b');
      await fake.tryLockWithToken('c');

      const calls = fake.getCalls();
      expect(calls.map((c) => [c.method, c.resource])).toEqual([
        ['withLock', 'a'],
        ['tryLock', 'b'],
        ['tryLockWithToken', 'c'],
      ]);
    });

    it('clearCalls empties the log without touching simulated locks', async () => {
      await fake.withLock('a', async () => null);
      fake.simulateLocked('locked-res');

      fake.clearCalls();

      expect(fake.getCalls()).toHaveLength(0);
      expect(await fake.isLocked('locked-res')).toBe(true);
    });
  });

  describe('EventEmitter compatibility', () => {
    it('can attach event listeners without throwing', () => {
      const handler = jest.fn();
      expect(() => fake.on('acquired', handler)).not.toThrow();
    });

    it('can emit events', () => {
      const handler = jest.fn();
      fake.on('acquired', handler);
      fake.emit('acquired', 'res', 5000);
      expect(handler).toHaveBeenCalledWith('res', 5000);
    });
  });

  describe('DI compatibility', () => {
    it('can replace LockService via useClass in test modules', async () => {
      // Verify FakeLockService can be used as a LockService substitute via DI
      const module: TestingModule = await Test.createTestingModule({
        providers: [{ provide: 'LockServiceToken', useClass: FakeLockService }],
      }).compile();

      const svc = module.get<FakeLockService>('LockServiceToken');
      const result = await svc.withLock('payment', async () => 'processed');
      expect(result).toBe('processed');
    });
  });
});
