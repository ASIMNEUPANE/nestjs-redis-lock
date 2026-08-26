import 'reflect-metadata';
import type { LockService } from '../src/lock.service';
import { clearActiveLockService } from '../src/lock.holder';
import { FakeLockService } from '../src/testing';
import { Lock } from '../src/lock.decorator';
import { getLockContext, runInLockContext, LockContext } from '../src/lock.context';

// This is in-process async-context plumbing, not a mutual-exclusion
// property, so FakeLockService (no Redis) is a legitimate stand-in here —
// unlike the concurrency-property tests elsewhere, which need real Redis.
describe('lock context (@Lock() exposing fencing token / AbortSignal)', () => {
  let fake: FakeLockService;

  beforeEach(() => {
    fake = new FakeLockService();
  });

  afterEach(() => {
    clearActiveLockService(fake as unknown as LockService);
  });

  it('returns undefined outside of any @Lock()-decorated invocation', () => {
    expect(getLockContext()).toBeUndefined();
  });

  it('exposes the signal and fencing token inside a decorated method', async () => {
    let seen: LockContext | undefined;

    class Job {
      @Lock({ key: 'ctx:test' })
      async run(): Promise<void> {
        seen = getLockContext();
      }
    }

    await new Job().run();

    expect(seen).toBeDefined();
    expect(seen?.resource).toBe('ctx:test');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.fencingToken).toBe(1);
  });

  it('increments the fencing token across successive acquisitions of the same resource', async () => {
    const seen: number[] = [];

    class Job {
      @Lock({ key: 'ctx:counter' })
      async run(): Promise<void> {
        seen.push(getLockContext()!.fencingToken);
      }
    }

    const job = new Job();
    await job.run();
    await job.run();
    await job.run();

    expect(seen).toEqual([1, 2, 3]);
  });

  it('isolates nested @Lock() calls, reverting to the outer context afterward', async () => {
    const seenInsideInner: (string | string[])[] = [];
    let outerBeforeNested: LockContext | undefined;
    let outerAfterNested: LockContext | undefined;

    class Job {
      @Lock({ key: 'ctx:inner' })
      async inner(): Promise<void> {
        seenInsideInner.push(getLockContext()!.resource);
      }

      @Lock({ key: 'ctx:outer' })
      async outer(): Promise<void> {
        outerBeforeNested = getLockContext();
        await this.inner();
        outerAfterNested = getLockContext();
      }
    }

    await new Job().outer();

    expect(seenInsideInner).toEqual(['ctx:inner']);
    expect(outerBeforeNested?.resource).toBe('ctx:outer');
    expect(outerAfterNested?.resource).toBe('ctx:outer');
    expect(outerAfterNested).toBe(outerBeforeNested);
  });

  it('does not populate getLockContext() for a direct LockService.withLock() call', async () => {
    let sawDuringDirectCall: LockContext | undefined;

    await fake.withLock('ctx:direct', async () => {
      sawDuringDirectCall = getLockContext();
    });

    expect(sawDuringDirectCall).toBeUndefined();
  });

  it('runInLockContext makes getLockContext() resolve inside fn, and only there', async () => {
    const context: LockContext = {
      resource: 'manual',
      signal: new AbortController().signal,
      fencingToken: 7,
    };

    let during: LockContext | undefined;
    await runInLockContext(context, async () => {
      during = getLockContext();
    });
    const after = getLockContext();

    expect(during).toBe(context);
    expect(after).toBeUndefined();
  });
});
