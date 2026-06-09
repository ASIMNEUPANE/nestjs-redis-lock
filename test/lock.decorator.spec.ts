import 'reflect-metadata';
import { LOCK_METADATA_KEY } from '../src/constants';
import { Lock } from '../src/lock.decorator';

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
