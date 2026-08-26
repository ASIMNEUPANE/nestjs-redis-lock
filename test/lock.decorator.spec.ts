import 'reflect-metadata';
import { SetMetadata } from '@nestjs/common';
import { LOCK_METADATA_KEY } from '../src/constants';
import { Lock } from '../src/lock.decorator';
import { LockService } from '../src/lock.service';
import { LockAcquisitionException } from '../src/exceptions/lock-acquisition.exception';
import { setActiveLockService, clearActiveLockService } from '../src/lock.holder';

// The @Lock() decorator stores options via SetMetadata.
// We test metadata storage directly via Reflect.getMetadata.
describe('Lock decorator', () => {
  it('attaches LockDecoratorOptions metadata to a method', () => {
    class TestClass {
      @Lock({ key: 'resource', duration: 5000, onFail: 'throw' })
      testMethod(): void {}
    }

    const metadata = Reflect.getMetadata(LOCK_METADATA_KEY, TestClass.prototype.testMethod);

    expect(metadata).toMatchObject({
      key: 'resource',
      duration: 5000,
      onFail: 'throw',
    });
  });

  it('works with dynamic key function', () => {
    const keyFn = (args: unknown[]): string => `item:${args[0]}`;

    class TestClass {
      @Lock({ key: keyFn })
      testMethod(): void {}
    }

    const metadata = Reflect.getMetadata(LOCK_METADATA_KEY, TestClass.prototype.testMethod);
    expect(metadata.key).toBe(keyFn);
  });

  it('stores onFail: skip correctly', () => {
    class TestClass {
      @Lock({ key: 'res', onFail: 'skip' })
      testMethod(): void {}
    }

    const metadata = Reflect.getMetadata(LOCK_METADATA_KEY, TestClass.prototype.testMethod);
    expect(metadata.onFail).toBe('skip');
  });

  it('stores only the provided options (no extra defaults injected)', () => {
    class TestClass {
      @Lock({ key: 'minimal' })
      testMethod(): void {}
    }

    const metadata = Reflect.getMetadata(LOCK_METADATA_KEY, TestClass.prototype.testMethod);
    expect(metadata).toEqual({ key: 'minimal' });
  });

  it('stores duration override', () => {
    class TestClass {
      @Lock({ key: 'job', duration: 30000 })
      testMethod(): void {}
    }

    const metadata = Reflect.getMetadata(LOCK_METADATA_KEY, TestClass.prototype.testMethod);
    expect(metadata.duration).toBe(30000);
  });
});

describe('Lock decorator — locking behavior', () => {
  const withLock = jest.fn(async (_resource: string | string[], callback: () => Promise<unknown>) =>
    callback(),
  );
  let mockService: LockService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockService = { withLock } as unknown as LockService;
    setActiveLockService(mockService, 'test-fingerprint');
  });

  afterEach(() => clearActiveLockService(mockService));

  // D2 regression: the interceptor passed ExecutionContext.getArgs(), which for
  // HTTP is [req, res, next] — so dynamic keys resolved to "seat:undefined".
  it('passes the method’s real arguments to the key function, spread', async () => {
    const keyFn = jest.fn((dto: { id: string }) => `booking:${dto.id}`);

    class BookingService {
      @Lock({ key: keyFn as (...args: unknown[]) => string })
      async book(dto: { id: string }, userId: string): Promise<string> {
        return `booked ${dto.id} for ${userId}`;
      }
    }

    const result = await new BookingService().book({ id: 'A1' }, 'user-7');

    expect(keyFn).toHaveBeenCalledWith({ id: 'A1' }, 'user-7');
    expect(withLock).toHaveBeenCalledWith('booking:A1', expect.any(Function), expect.any(Object));
    expect(result).toBe('booked A1 for user-7');
  });

  // D3 regression: interceptors never run for @Cron handlers or plain providers.
  it('locks plain provider methods, with no request pipeline involved', async () => {
    class ReportJob {
      @Lock({ key: 'cron:daily-report' })
      async run(): Promise<string> {
        return 'done';
      }
    }

    expect(await new ReportJob().run()).toBe('done');
    expect(withLock).toHaveBeenCalledWith(
      'cron:daily-report',
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('preserves `this` binding on the decorated instance', async () => {
    class Counter {
      value = 41;

      @Lock({ key: 'counter' })
      async bump(): Promise<number> {
        return ++this.value;
      }
    }

    expect(await new Counter().bump()).toBe(42);
  });

  // Nest and @nestjs/schedule read metadata off the method function itself.
  // Replacing descriptor.value without copying it silently unregisters
  // routes and cron jobs, depending on decorator order.
  it('preserves the original method name and inherited metadata', () => {
    const CRON_KEY = 'SCHEDULE_CRON_OPTIONS';

    class Job {
      @Lock({ key: 'job' })
      @SetMetadata(CRON_KEY, { cronTime: '*/10 * * * * *' })
      async handleCron(): Promise<void> {}
    }

    const method = Job.prototype.handleCron;
    expect(method.name).toBe('handleCron');
    expect(Reflect.getMetadata(CRON_KEY, method)).toEqual({ cronTime: '*/10 * * * * *' });
  });

  it('propagates the callback result and rethrows callback errors', async () => {
    class Svc {
      @Lock({ key: 'res' })
      async boom(): Promise<never> {
        throw new Error('callback failed');
      }
    }

    await expect(new Svc().boom()).rejects.toThrow('callback failed');
  });

  it('returns undefined instead of throwing when onFail is "skip"', async () => {
    withLock.mockRejectedValueOnce(new LockAcquisitionException('res', 3, 600));

    class Job {
      @Lock({ key: 'res', onFail: 'skip' })
      async run(): Promise<string> {
        return 'ran';
      }
    }

    expect(await new Job().run()).toBeUndefined();
  });

  it('rethrows the acquisition failure when onFail is "throw"', async () => {
    withLock.mockRejectedValueOnce(new LockAcquisitionException('res', 3, 600));

    class Job {
      @Lock({ key: 'res', onFail: 'throw' })
      async run(): Promise<string> {
        return 'ran';
      }
    }

    await expect(new Job().run()).rejects.toBeInstanceOf(LockAcquisitionException);
  });

  it('rethrows non-acquisition errors even when onFail is "skip"', async () => {
    withLock.mockRejectedValueOnce(new TypeError('redis exploded'));

    class Job {
      @Lock({ key: 'res', onFail: 'skip' })
      async run(): Promise<string> {
        return 'ran';
      }
    }

    await expect(new Job().run()).rejects.toBeInstanceOf(TypeError);
  });

  it('explains what to do when LockModule was never registered', async () => {
    clearActiveLockService(mockService);

    class Job {
      @Lock({ key: 'res' })
      async run(): Promise<void> {}
    }

    await expect(new Job().run()).rejects.toThrow(/LockModule\.register/);
  });
});
