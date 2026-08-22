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
// These tests flush the database they run against. Default to a scratch DB
// index so a developer pointing at their everyday Redis does not lose it.
const DB = Number(process.env.REDIS_DB ?? 15);

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
    client = new Redis({ host: HOST, port: PORT, db: DB, maxRetriesPerRequest: null });
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

  describe('semaphore (maxConcurrent: N)', () => {
    it('admits exactly N concurrent holders, not 1 and not all', async () => {
      const N = 5;
      // contend()'s counter is *deliberately* unsafe under concurrent access
      // (that's what makes it a mutual-exclusion proof for maxConcurrent: 1).
      // A semaphore's whole point is that N holders genuinely race each
      // other, so the counter would legitimately undercount here — `order`
      // is a safe, append-only record of who got admitted, which is what
      // this test actually needs to check.
      const { maxConcurrent, order } = await contend(N + 10, (_i, body) =>
        service.withLock('pool', body, { duration: 5000, maxConcurrent: N, queueTimeout: 25_000 }),
      );

      expect(maxConcurrent).toBe(N);
      expect(order).toHaveLength(N + 10);
    });

    it('blocks the (N+1)th caller until a slot frees', async () => {
      const N = 3;
      const releases: Array<() => void> = [];
      const holds = Array.from(
        { length: N },
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );

      const started: number[] = [];
      const holders = holds.map((hold, i) =>
        service.withLock(
          'pool-block',
          async () => {
            started.push(i);
            await hold;
          },
          { duration: 10_000, maxConcurrent: N },
        ),
      );

      // Give the N holders time to actually acquire before the extra caller arrives.
      await new Promise((r) => setTimeout(r, 200));
      expect(started).toHaveLength(N);

      let extraStarted = false;
      const extra = service.withLock(
        'pool-block',
        async () => {
          extraStarted = true;
        },
        { duration: 5000, maxConcurrent: N, queueTimeout: 20_000 },
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(extraStarted).toBe(false);

      releases[0]();
      await extra;
      expect(extraStarted).toBe(true);

      releases.slice(1).forEach((release) => release());
      await Promise.all(holders);
    });

    it('leaves no queue or owner entries behind after completion', async () => {
      await service.withLock('pool-tidy', async () => 'ok', { duration: 2000, maxConcurrent: 2 });
      expect(await client.zcard('itest:pool-tidy:sem:queue')).toBe(0);
      expect(await client.zcard('itest:pool-tidy:sem')).toBe(0);
    });

    it('rejects maxConcurrent combined with a lock group', async () => {
      await expect(
        service.withLock(['g1', 'g2'], async () => null, { maxConcurrent: 2 }),
      ).rejects.toThrow(/lock groups/);
    });

    it('rejects maxConcurrent combined with queue', async () => {
      await expect(
        service.withLock('res', async () => null, { maxConcurrent: 2, queue: true }),
      ).rejects.toThrow(/cannot be combined/);
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

  describe('read-write locks (mode: "read" | "write")', () => {
    it('lets concurrent readers genuinely overlap', async () => {
      const intervals: Array<{ start: number; end: number }> = [];
      const read = () =>
        service.withLock(
          'doc',
          async () => {
            const start = Date.now();
            await new Promise((r) => setTimeout(r, 200));
            intervals.push({ start, end: Date.now() });
          },
          { duration: 5000, mode: 'read' },
        );

      await Promise.all([read(), read(), read()]);

      expect(intervals).toHaveLength(3);
      // If they were serialized, the 3rd reader's start would be >= the
      // 1st's end (~400ms later). Overlap means it starts near the others.
      const starts = intervals.map((i) => i.start).sort((a, b) => a - b);
      expect(starts[2] - starts[0]).toBeLessThan(100);
    });

    it('excludes all readers while a writer holds the lock', async () => {
      const events: string[] = [];

      let releaseWriter!: () => void;
      const writerHeld = new Promise<void>((r) => (releaseWriter = r));
      const writer = service.withLock(
        'doc',
        async () => {
          events.push('writer-start');
          await writerHeld;
          events.push('writer-end');
        },
        { duration: 10_000, mode: 'write' },
      );

      // Give the writer time to actually acquire before readers arrive.
      await new Promise((r) => setTimeout(r, 150));
      expect(events).toEqual(['writer-start']);

      const reader = service.withLock(
        'doc',
        async () => {
          events.push('reader-start');
        },
        { duration: 5000, mode: 'read', queueTimeout: 20_000 },
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(events).toEqual(['writer-start']); // reader still blocked

      releaseWriter();
      await Promise.all([writer, reader]);

      expect(events).toEqual(['writer-start', 'writer-end', 'reader-start']);
    });

    it('excludes a writer while any reader holds the lock', async () => {
      const events: string[] = [];

      let releaseReader!: () => void;
      const readerHeld = new Promise<void>((r) => (releaseReader = r));
      const reader = service.withLock(
        'doc2',
        async () => {
          events.push('reader-start');
          await readerHeld;
          events.push('reader-end');
        },
        { duration: 10_000, mode: 'read' },
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(events).toEqual(['reader-start']);

      const writer = service.withLock(
        'doc2',
        async () => {
          events.push('writer-start');
        },
        { duration: 5000, mode: 'write', queueTimeout: 20_000 },
      );

      await new Promise((r) => setTimeout(r, 150));
      expect(events).toEqual(['reader-start']); // writer still blocked

      releaseReader();
      await Promise.all([reader, writer]);

      expect(events).toEqual(['reader-start', 'reader-end', 'writer-start']);
    });

    it('does not starve a waiting writer under a steady stream of readers', async () => {
      const events: string[] = [];
      let stop = false;

      // A continuous stream of short-lived readers arriving faster than the
      // writer-waiting marker's TTL — without the starvation guard, this
      // stream never lets the read count hit zero at the same instant a
      // writer checks, so the writer could wait indefinitely.
      const readerLoop = (async () => {
        while (!stop) {
          await service
            .withLock(
              'doc3',
              async () => {
                await new Promise((r) => setTimeout(r, 20));
              },
              { duration: 2000, mode: 'read' },
            )
            .catch(() => undefined);
        }
      })();

      // Let a few readers get going first.
      await new Promise((r) => setTimeout(r, 100));

      const writer = service.withLock(
        'doc3',
        async () => {
          events.push('writer-acquired');
        },
        { duration: 2000, mode: 'write', queueTimeout: 5_000 },
      );

      await writer;
      stop = true;
      await readerLoop;

      expect(events).toEqual(['writer-acquired']);
    });

    it('releases all read-write Redis state after completion', async () => {
      await service.withLock('doc-tidy', async () => 'ok', { duration: 2000, mode: 'read' });
      await service.withLock('doc-tidy', async () => 'ok', { duration: 2000, mode: 'write' });

      expect(await client.zcard('itest:doc-tidy:rw:readers')).toBe(0);
      expect(await client.exists('itest:doc-tidy:rw:writer')).toBe(0);
      expect(await client.exists('itest:doc-tidy:rw:writer-waiting')).toBe(0);
      expect(await client.zcard('itest:doc-tidy:rw:writers:queue')).toBe(0);
    });

    it('rejects mode combined with queue, maxConcurrent, or array resources', async () => {
      await expect(
        service.withLock('res', async () => null, { mode: 'read', queue: true }),
      ).rejects.toThrow(/cannot be combined/);
      await expect(
        service.withLock('res', async () => null, { mode: 'write', maxConcurrent: 2 }),
      ).rejects.toThrow(/cannot be combined/);
      await expect(
        service.withLock(['a', 'b'], async () => null, { mode: 'read' }),
      ).rejects.toThrow(/lock groups/);
    });
  });

  describe('fencing tokens', () => {
    it('issues a strictly increasing token on each sequential acquisition', async () => {
      const tokens: number[] = [];
      for (let i = 0; i < 5; i++) {
        await service.withLock('sku-42', async (_signal, token) => {
          tokens.push(token);
        });
      }

      for (let i = 1; i < tokens.length; i++) {
        expect(tokens[i]).toBeGreaterThan(tokens[i - 1]);
      }
    });

    it('shares one fence counter across a lock group', async () => {
      const first = await service.withLock(['seat:g1', 'seat:g2'], async (_s, token) => token);
      const second = await service.withLock(['seat:g1', 'seat:g2'], async (_s, token) => token);
      expect(second).toBeGreaterThan(first);
    });

    it('tryLockWithToken returns an increasing token alongside the lock', async () => {
      const first = await service.tryLockWithToken('sku-99', 2000);
      await first!.lock.release();
      const second = await service.tryLockWithToken('sku-99', 2000);
      await second!.lock.release();

      expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
    });
  });

  describe('AbortSignal on lock loss', () => {
    it('provides a signal that stays unaborted through a healthy autoExtend hold', async () => {
      let observed: AbortSignal | undefined;
      await service.withLock(
        'healthy-hold',
        async (signal) => {
          observed = signal;
          await new Promise((r) => setTimeout(r, 300));
        },
        { duration: 200, autoExtend: true },
      );
      expect(observed?.aborted).toBe(false);
    });

    it('aborts the signal when auto-extend can no longer reach Redis', async () => {
      // A dedicated client so disconnecting it doesn't break other tests
      // sharing the suite's client.
      const extendClient = new Redis({ host: HOST, port: PORT, db: DB, maxRetriesPerRequest: 1 });
      await extendClient.ping();

      const extendModule = await Test.createTestingModule({
        providers: [
          LockService,
          {
            provide: LOCK_MODULE_OPTIONS,
            useValue: {
              clients: [extendClient],
              duration: 200,
              retryCount: 0,
              keyPrefix: 'itest',
            },
          },
        ],
      }).compile();
      const extendService = extendModule.get(LockService);

      let sawAbort = false;
      await extendService.withLock(
        'extend-loss',
        async (signal) => {
          // Cut the connection mid-hold so the next auto-extend attempt fails.
          extendClient.disconnect();
          // duration=200 → extend interval fires at ~100ms; give it two.
          await new Promise((r) => setTimeout(r, 350));
          sawAbort = signal.aborted;
        },
        { duration: 200, autoExtend: true },
      );

      expect(sawAbort).toBe(true);
      await extendModule.close().catch(() => undefined);
    });
  });
});
