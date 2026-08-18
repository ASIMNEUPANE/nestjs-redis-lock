import Redis from 'ioredis';
import { Test, TestingModule } from '@nestjs/testing';
import { LockService } from '../../src/lock.service';
import { LOCK_MODULE_OPTIONS } from '../../src/constants';
import { LockAcquisitionException } from '../../src/exceptions/lock-acquisition.exception';

/**
 * Integration tests against a real Redis.
 *
 * The point of this file is mutual exclusion under genuine concurrency.
 * v1.0.0's queued locking passed every mocked unit test while letting N
 * callers into the critical section simultaneously — only a test like
 * `criticalSection()` below can catch that.
 */
const HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT ?? 6379);

/**
 * Runs `n` concurrent lock attempts around a deliberately unsafe
 * read → await → write sequence. Returns the final counter plus the peak
 * number of callers observed inside the critical section at once.
 */
async function contend(
  n: number,
  run: (index: number, body: () => Promise<void>) => Promise<unknown>,
): Promise<{ counter: number; maxConcurrent: number; order: number[] }> {
  let counter = 0;
  let inside = 0;
  let maxConcurrent = 0;
  const order: number[] = [];

  const body = (index: number) => async (): Promise<void> => {
    inside += 1;
    maxConcurrent = Math.max(maxConcurrent, inside);
    order.push(index);

    // Read-modify-write with a yield in the middle: unprotected, this
    // interleaves and loses updates.
    const snapshot = counter;
    await new Promise((r) => setTimeout(r, 5));
    counter = snapshot + 1;

    inside -= 1;
  };

  await Promise.all(Array.from({ length: n }, (_, i) => run(i, body(i))));

  return { counter, maxConcurrent, order };
}

describe('LockService (integration — real Redis)', () => {
  let client: Redis;
  let module: TestingModule;
  let service: LockService;

  beforeAll(async () => {
    client = new Redis({ host: HOST, port: PORT, maxRetriesPerRequest: null });
    await client.ping();
  });

  beforeEach(async () => {
    await client.flushdb();
    module = await Test.createTestingModule({
      providers: [
        LockService,
        {
          provide: LOCK_MODULE_OPTIONS,
          useValue: {
            clients: [client],
            duration: 5000,
            retryCount: 200,
            retryDelay: 50,
            retryJitter: 25,
            keyPrefix: 'itest',
          },
        },
      ],
    }).compile();
    service = module.get(LockService);
  });

  afterEach(async () => {
    // Don't quit the shared client here — onModuleDestroy would close it.
    await module.close().catch(() => undefined);
  });

  afterAll(async () => {
    await client.quit();
  });

  describe('mutual exclusion', () => {
    it('serializes 50 concurrent callers on the default path', async () => {
      const { counter, maxConcurrent } = await contend(50, (_i, body) =>
        service.withLock('counter', body, { duration: 5000 }),
      );

      expect(maxConcurrent).toBe(1);
      expect(counter).toBe(50);
    });

    // This is the regression test for the v1.0.0 queue, which minted a fresh
    // semaphore token whenever BRPOP emptied (and therefore deleted) the list.
    it('serializes 50 concurrent callers on the queued path', async () => {
      const { counter, maxConcurrent } = await contend(50, (_i, body) =>
        service.withLock('queued-counter', body, {
          duration: 5000,
          queue: true,
          queueTimeout: 25_000,
        }),
      );

      expect(maxConcurrent).toBe(1);
      expect(counter).toBe(50);
    });

    it('serializes concurrent callers on the lock-group path', async () => {
      const { counter, maxConcurrent } = await contend(20, (_i, body) =>
        service.withLock(['seat:A1', 'seat:B2'], body, { duration: 5000 }),
      );

      expect(maxConcurrent).toBe(1);
      expect(counter).toBe(20);
    });

    it('lets non-overlapping lock groups run in parallel', async () => {
      const started: string[] = [];
      const hold = (keys: string[]) =>
        service.withLock(keys, async () => {
          started.push(keys.join(','));
          await new Promise((r) => setTimeout(r, 300));
        });

      const elapsed = Date.now();
      await Promise.all([hold(['g:a1', 'g:a2']), hold(['g:b1', 'g:b2'])]);

      expect(started).toHaveLength(2);
      // Serialized would be ~600ms; overlapping should land well under that.
      expect(Date.now() - elapsed).toBeLessThan(550);
    });
  });

  describe('queue fairness', () => {
    it('serves callers in arrival order', async () => {
      const order: number[] = [];

      // Hold the lock so everyone queues behind a known blocker.
      let releaseBlocker!: () => void;
      const blocked = new Promise<void>((r) => (releaseBlocker = r));
      const blocker = service.withLock('fair', () => blocked, {
        duration: 10_000,
        queue: true,
      });

      // Stagger entry so arrival order is unambiguous.
      const waiters: Promise<unknown>[] = [];
      for (let i = 0; i < 5; i++) {
        waiters.push(
          service.withLock(
            'fair',
            async () => {
              order.push(i);
            },
            { duration: 5000, queue: true, queueTimeout: 20_000 },
          ),
        );
        await new Promise((r) => setTimeout(r, 60));
      }

      releaseBlocker();
      await blocker;
      await Promise.all(waiters);

      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it('times out with LockAcquisitionException rather than waiting forever', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const holder = service.withLock('busy', () => held, { duration: 10_000, queue: true });

      // Let the holder reach the head of the queue and take the lock first.
      await new Promise((r) => setTimeout(r, 150));

      await expect(
        service.withLock('busy', async () => 'never', {
          duration: 5000,
          queue: true,
          queueTimeout: 300,
        }),
      ).rejects.toBeInstanceOf(LockAcquisitionException);

      release();
      await holder;
    });

    it('does not leave queue entries behind after completion', async () => {
      await service.withLock('tidy', async () => 'ok', { duration: 2000, queue: true });
      expect(await client.zcard('itest:tidy:queue')).toBe(0);
    });
  });

  describe('lock lifecycle', () => {
    it('releases the lock when the callback throws', async () => {
      await expect(
        service.withLock('throws', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await service.isLocked('throws')).toBe(false);
      expect(await service.withLock('throws', async () => 'reacquired')).toBe('reacquired');
    });

    it('isLocked reflects real key state without acquiring anything', async () => {
      expect(await service.isLocked('probe')).toBe(false);

      await service.withLock('probe', async () => {
        expect(await service.isLocked('probe')).toBe(true);
      });

      expect(await service.isLocked('probe')).toBe(false);
    });

    it('auto-extend keeps a long callback’s lock alive past its TTL', async () => {
      const result = await service.withLock(
        'long-job',
        async () => {
          // Three times the TTL — without extension this lock would expire.
          await new Promise((r) => setTimeout(r, 900));
          return 'finished';
        },
        { duration: 300, autoExtend: true },
      );

      expect(result).toBe('finished');
      expect(await service.isLocked('long-job')).toBe(false);
    });

    it('tryLock returns null for a held resource and a Lock for a free one', async () => {
      // A no-retry service, so "already held" is answered immediately rather
      // than waiting out the holder's TTL.
      const noRetry = (
        await Test.createTestingModule({
          providers: [
            LockService,
            {
              provide: LOCK_MODULE_OPTIONS,
              useValue: { clients: [client], duration: 2000, retryCount: 0, keyPrefix: 'itest' },
            },
          ],
        }).compile()
      ).get(LockService);

      const first = await noRetry.tryLock('try', 2000);
      expect(first).not.toBeNull();

      const second = await noRetry.tryLock('try', 2000);
      expect(second).toBeNull();

      await first!.release();
      const third = await noRetry.tryLock('try', 2000);
      expect(third).not.toBeNull();
      await third!.release();
    });

    it('extend() pushes out an existing lock’s expiration', async () => {
      const lock = await service.tryLock('extendable', 500);
      const extended = await service.extend(lock!, 5000);
      expect(extended.expiration).toBeGreaterThan(lock!.expiration);
      await extended.release();
    });
  });

  describe('failure reporting', () => {
    // The v1.0.0 bug: tryLock swallowed connection failures as "already held",
    // so the Terminus health check reported "up" against a dead Redis.
    it('re-throws instead of reporting contention when Redis is unreachable', async () => {
      const deadClient = new Redis({
        host: '127.0.0.1',
        port: 6390, // nothing listening
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        enableOfflineQueue: false,
      });
      deadClient.on('error', () => undefined);

      const deadModule = await Test.createTestingModule({
        providers: [
          LockService,
          {
            provide: LOCK_MODULE_OPTIONS,
            useValue: { clients: [deadClient], duration: 1000, retryCount: 0, keyPrefix: 'dead' },
          },
        ],
      }).compile();
      const deadService = deadModule.get(LockService);

      await expect(deadService.tryLock('anything', 1000)).rejects.toBeDefined();

      await deadModule.close().catch(() => undefined);
      deadClient.disconnect();
    });
  });
});
