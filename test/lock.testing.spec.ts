import { Test, TestingModule } from '@nestjs/testing';
import { FakeLockService } from '../src/testing';

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
  });

  describe('tryLock()', () => {
    it('returns null without acquiring any lock', async () => {
      const lock = await fake.tryLock('res');
      expect(lock).toBeNull();
    });

    it('returns null regardless of duration', async () => {
      const lock = await fake.tryLock('res', 9000);
      expect(lock).toBeNull();
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
    it('always returns false', async () => {
      const locked = await fake.isLocked('res');
      expect(locked).toBe(false);
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
