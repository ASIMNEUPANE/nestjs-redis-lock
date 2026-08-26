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

    it('ignores duration and autoExtend (queue/maxConcurrent/mode are simulated, not ignored)', async () => {
      const result = await fake.withLock('res', async () => 42, 10000, true, false);
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

  describe('queue: true / maxConcurrent: N (simulated admission)', () => {
    async function flush(times = 5): Promise<void> {
      for (let i = 0; i < times; i++) {
        await Promise.resolve();
      }
    }

    function heldCall(
      resource: string,
      options: Parameters<FakeLockService['withLock']>[2],
    ): { done: Promise<void>; release: () => void } {
      let release!: () => void;
      const done = fake.withLock(
        resource,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        options,
      );
      return { done, release: () => release() };
    }

    it('admits up to maxConcurrent callers immediately', async () => {
      const entered: number[] = [];
      const a = fake.withLock('pool', async () => entered.push(1), { maxConcurrent: 2 });
      const b = fake.withLock('pool', async () => entered.push(2), { maxConcurrent: 2 });
      await Promise.all([a, b]);
      expect(entered.sort()).toEqual([1, 2]);
    });

    it('blocks the (N+1)th caller until a slot frees, then admits it', async () => {
      const held1 = heldCall('pool', { maxConcurrent: 2 });
      const held2 = heldCall('pool', { maxConcurrent: 2 });
      await flush();

      let thirdEntered = false;
      const third = fake.withLock(
        'pool',
        async () => {
          thirdEntered = true;
        },
        { maxConcurrent: 2 },
      );
      await flush();
      expect(thirdEntered).toBe(false);

      held1.release();
      await held1.done;
      await third;
      expect(thirdEntered).toBe(true);

      held2.release();
      await held2.done;
    });

    it('treats queue: true as maxConcurrent: 1', async () => {
      const held = heldCall('single', { queue: true });
      await flush();

      let secondEntered = false;
      const second = fake.withLock(
        'single',
        async () => {
          secondEntered = true;
        },
        { queue: true },
      );
      await flush();
      expect(secondEntered).toBe(false);

      held.release();
      await held.done;
      await second;
      expect(secondEntered).toBe(true);
    });

    it('rejects a non-positive-integer maxConcurrent', async () => {
      await expect(fake.withLock('res', async () => 'ok', { maxConcurrent: 0 })).rejects.toThrow(
        'positive integer',
      );
    });

    it('rejects queue and maxConcurrent combined', async () => {
      await expect(
        fake.withLock('res', async () => 'ok', { queue: true, maxConcurrent: 2 }),
      ).rejects.toThrow('cannot be combined');
    });

    it('rejects queue for lock groups', async () => {
      await expect(fake.withLock(['a', 'b'], async () => 'ok', { queue: true })).rejects.toThrow(
        'not supported for lock groups',
      );
    });

    it('rejects maxConcurrent for lock groups', async () => {
      await expect(
        fake.withLock(['a', 'b'], async () => 'ok', { maxConcurrent: 2 }),
      ).rejects.toThrow('not supported for lock groups');
    });
  });

  describe('mode: "read" | "write" (simulated)', () => {
    async function flush(times = 5): Promise<void> {
      for (let i = 0; i < times; i++) {
        await Promise.resolve();
      }
    }

    function heldCall(
      resource: string,
      mode: 'read' | 'write',
    ): { done: Promise<void>; release: () => void } {
      let release!: () => void;
      const done = fake.withLock(
        resource,
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        { mode },
      );
      return { done, release: () => release() };
    }

    it('allows concurrent readers', async () => {
      const entered: string[] = [];
      const a = fake.withLock('doc', async () => entered.push('a'), { mode: 'read' });
      const b = fake.withLock('doc', async () => entered.push('b'), { mode: 'read' });
      await Promise.all([a, b]);
      expect(entered.sort()).toEqual(['a', 'b']);
    });

    it('excludes readers while a writer holds the lock', async () => {
      const writer = heldCall('doc', 'write');
      await flush();

      let readerEntered = false;
      const reader = fake.withLock(
        'doc',
        async () => {
          readerEntered = true;
        },
        { mode: 'read' },
      );
      await flush();
      expect(readerEntered).toBe(false);

      writer.release();
      await writer.done;
      await reader;
      expect(readerEntered).toBe(true);
    });

    it('excludes a writer while a reader holds the lock', async () => {
      const reader = heldCall('doc', 'read');
      await flush();

      let writerEntered = false;
      const writer = fake.withLock(
        'doc',
        async () => {
          writerEntered = true;
        },
        { mode: 'write' },
      );
      await flush();
      expect(writerEntered).toBe(false);

      reader.release();
      await reader.done;
      await writer;
      expect(writerEntered).toBe(true);
    });

    it('stops a new reader from jumping ahead of a queued writer (starvation guard)', async () => {
      const reader1 = heldCall('doc', 'read');
      await flush();
      const writer = heldCall('doc', 'write');
      await flush(); // writer is now queued behind reader1

      let reader2Entered = false;
      const reader2 = fake.withLock(
        'doc',
        async () => {
          reader2Entered = true;
        },
        { mode: 'read' },
      );
      await flush();
      expect(reader2Entered).toBe(false);

      reader1.release();
      await reader1.done;
      await flush();
      expect(reader2Entered).toBe(false); // writer holds now; reader2 still waits

      writer.release();
      await writer.done;
      await reader2;
      expect(reader2Entered).toBe(true);
    });

    it('rejects mode combined with queue or maxConcurrent', async () => {
      await expect(
        fake.withLock('res', async () => 'ok', { mode: 'read', queue: true }),
      ).rejects.toThrow('cannot be combined');
      await expect(
        fake.withLock('res', async () => 'ok', { mode: 'write', maxConcurrent: 2 }),
      ).rejects.toThrow('cannot be combined');
    });

    it('rejects mode for lock groups', async () => {
      await expect(fake.withLock(['a', 'b'], async () => 'ok', { mode: 'read' })).rejects.toThrow(
        'not supported for lock groups',
      );
    });
  });

  describe('simulateLockLoss()', () => {
    it('aborts the signal of an in-flight callback for that resource', async () => {
      let aborted = false;
      const call = fake.withLock(
        'job',
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          }),
        { autoExtend: true },
      );

      // Give the callback a tick to register its listener.
      await Promise.resolve();
      fake.simulateLockLoss('job');
      await call;

      expect(aborted).toBe(true);
    });

    it('is a no-op when nothing is in flight for that resource', () => {
      expect(() => fake.simulateLockLoss('idle')).not.toThrow();
    });
  });

  describe('resetQueueState()', () => {
    it('clears stuck admission state so a later acquisition is not blocked by an abandoned holder', async () => {
      // Never resolves — simulates a caller that acquired the only slot and
      // was then abandoned (e.g. a leaked promise from an earlier test).
      void fake.withLock('pool', () => new Promise<void>(() => undefined), { maxConcurrent: 1 });
      await Promise.resolve(); // let it acquire the slot

      let blockedEntered = false;
      const blocked = fake.withLock(
        'pool',
        async () => {
          blockedEntered = true;
        },
        { maxConcurrent: 1 },
      );
      await Promise.resolve();
      expect(blockedEntered).toBe(false); // stuck behind the abandoned holder

      fake.resetQueueState('pool');

      let freshEntered = false;
      await fake.withLock(
        'pool',
        async () => {
          freshEntered = true;
        },
        { maxConcurrent: 1 },
      );
      expect(freshEntered).toBe(true); // reset cleared the stuck bookkeeping

      // `blocked` stays queued forever behind the abandoned holder — reset
      // only clears the map's admission state for *future* callers, it
      // doesn't resolve promises already waiting on the old queue.
      void blocked;
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
