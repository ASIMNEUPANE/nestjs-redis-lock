import { Test, TestingModule } from '@nestjs/testing';
import { LockModule } from '../src/lock.module';
import { LockService } from '../src/lock.service';
import { LockInterceptor } from '../src/lock.interceptor';
import { LOCK_MODULE_OPTIONS } from '../src/constants';

jest.mock('redlock', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    acquire: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  })),
  ExecutionError: class ExecutionError extends Error {},
  ResourceLockedError: class ResourceLockedError extends Error {},
}));

describe('LockModule', () => {
  const mockClients = [{}];

  describe('register()', () => {
    let module: TestingModule;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [LockModule.register({ clients: mockClients, duration: 5000 })],
      }).compile();
    });

    afterEach(async () => {
      await module.close();
    });

    it('provides LockService', () => {
      expect(module.get(LockService)).toBeDefined();
    });

    it('provides LockInterceptor', () => {
      expect(module.get(LockInterceptor)).toBeDefined();
    });

    it('provides LOCK_MODULE_OPTIONS with correct values', () => {
      const options = module.get(LOCK_MODULE_OPTIONS);
      expect(options).toMatchObject({ clients: mockClients, duration: 5000 });
    });
  });

  describe('registerAsync()', () => {
    let module: TestingModule;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [
          LockModule.registerAsync({
            useFactory: () => ({ clients: mockClients, keyPrefix: 'test' }),
          }),
        ],
      }).compile();
    });

    afterEach(async () => {
      await module.close();
    });

    it('provides LockService via async factory', () => {
      expect(module.get(LockService)).toBeDefined();
    });

    it('resolves factory options correctly', () => {
      const options = module.get(LOCK_MODULE_OPTIONS);
      expect(options.keyPrefix).toBe('test');
    });

    it('provides LockInterceptor', () => {
      expect(module.get(LockInterceptor)).toBeDefined();
    });
  });
});
