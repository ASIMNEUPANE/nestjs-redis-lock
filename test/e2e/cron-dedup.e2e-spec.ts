import 'reflect-metadata';
import Redis from 'ioredis';
import { Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ScheduleModule, Cron } from '@nestjs/schedule';
import { Lock } from '../../src/lock.decorator';
import { LockModule } from '../../src/lock.module';

/**
 * The headline claim of the cron-dedup example: in a cluster, only one
 * instance runs a scheduled job per tick.
 *
 * In v1.0.0 `@Lock()` installed a NestJS interceptor, and interceptors never
 * run for `@Cron` handlers — @nestjs/schedule invokes the method directly on
 * the provider. Every instance ran every tick. These tests boot two real Nest
 * applications against one Redis to prove the wrapper fixed it, and that the
 * cron job is still registered at all after the method is wrapped.
 */
const HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT ?? 6379);
// These tests flush the database they run against. Default to a scratch DB
// index so a developer pointing at their everyday Redis does not lose it.
const DB = Number(process.env.REDIS_DB ?? 15);

/** Every tick that actually made it into the critical section. */
const runs: string[] = [];
/** Peak number of instances inside the job body at the same moment. */
let inside = 0;
let maxConcurrent = 0;

@Injectable()
class ReportJobService {
  constructor(private readonly instanceId: string) {}

  @Cron('*/1 * * * * *')
  @Lock({ key: 'cron:daily-report', onFail: 'skip' })
  async generateDailyReport(): Promise<void> {
    runs.push(this.instanceId);
    inside += 1;
    maxConcurrent = Math.max(maxConcurrent, inside);
    // Hold past the tick interval so a second instance would visibly overlap.
    await new Promise((r) => setTimeout(r, 1200));
    inside -= 1;
  }
}

function buildInstance(instanceId: string, client: Redis, keyPrefix = 'cron-itest') {
  @Module({
    imports: [
      ScheduleModule.forRoot(),
      LockModule.register({
        clients: [client],
        // TTL comfortably longer than the job, so the winner keeps the lock.
        duration: 5000,
        retryCount: 0, // Lose the race → skip this tick, don't wait for the next
        keyPrefix,
      }),
    ],
    providers: [{ provide: ReportJobService, useFactory: () => new ReportJobService(instanceId) }],
  })
  class AppModule {}

  return Test.createTestingModule({ imports: [AppModule] }).compile();
}

describe('@Lock() on @Cron handlers (integration — real Redis)', () => {
  let client: Redis;

  beforeAll(async () => {
    client = new Redis({ host: HOST, port: PORT, db: DB, maxRetriesPerRequest: null });
    await client.ping();
  });

  afterAll(async () => {
    await client.quit();
  });

  beforeEach(async () => {
    runs.length = 0;
    inside = 0;
    maxConcurrent = 0;
    await client.del('cron-itest:cron:daily-report');
  });

  it('keeps the cron registration alive through the @Lock() wrapper', async () => {
    const app = await buildInstance('solo', client);
    await app.init();

    // If wrapping had dropped the SCHEDULE_CRON_OPTIONS metadata, no job would
    // be registered and this would stay empty.
    await new Promise((r) => setTimeout(r, 2500));
    expect(runs.length).toBeGreaterThan(0);

    await app.close();
  }, 20_000);

  it('runs the job on only one of two instances per tick', async () => {
    const [appA, appB] = await Promise.all([
      buildInstance('instance-a', client),
      buildInstance('instance-b', client),
    ]);
    await Promise.all([appA.init(), appB.init()]);

    // Let several ticks fire on both instances simultaneously.
    await new Promise((r) => setTimeout(r, 5000));
    await Promise.all([appA.close(), appB.close()]);

    // Both instances did fire — the job is registered on each.
    expect(runs.length).toBeGreaterThan(0);

    // The property that matters: the job body was never running on two
    // instances at once. Without a working lock this reaches 2, because each
    // job holds ~1.2s against a 1s tick.
    expect(maxConcurrent).toBe(1);
  }, 30_000);

  // Regression for the lock.holder.ts collision: @Lock() resolves exactly one
  // LockService per process. This proves the *limitation* exists and is now
  // surfaced with a warning — not that both configurations work correctly at
  // once through @Lock() (they still can't; the earlier module's decorated
  // methods silently start acquiring locks under the later module's prefix).
  it('warns when a second LockModule with a different config is registered', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const appA = await buildInstance('instance-a', client, 'cron-itest-a');
      await appA.init();
      const appB = await buildInstance('instance-b', client, 'cron-itest-b');
      await appB.init();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/exposeToDecorator: false/));

      await Promise.all([appA.close(), appB.close()]);
    } finally {
      warnSpy.mockRestore();
    }
  }, 20_000);
});
