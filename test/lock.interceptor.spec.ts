import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { LockInterceptor } from '../src/lock.interceptor';
import { LockService } from '../src/lock.service';
import { LockAcquisitionException } from '../src/exceptions/lock-acquisition.exception';

describe('LockInterceptor', () => {
  let interceptor: LockInterceptor;
  let reflectorGet: jest.Mock;
  let lockServiceWithLock: jest.Mock;

  beforeEach(async () => {
    reflectorGet = jest.fn();
    lockServiceWithLock = jest
      .fn()
      .mockImplementation((_resource: string, callback: () => Promise<unknown>) => callback());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LockInterceptor,
        { provide: Reflector, useValue: { get: reflectorGet } },
        { provide: LockService, useValue: { withLock: lockServiceWithLock } },
      ],
    }).compile();

    interceptor = module.get(LockInterceptor);
  });

  function createContext(args: unknown[] = [{ id: 42 }]): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getArgs: () => args,
    } as unknown as ExecutionContext;
  }

  function createCallHandler(value: unknown = 'response'): CallHandler {
    return { handle: () => of(value) } as CallHandler;
  }

  it('passes through when no @Lock metadata is present', (done) => {
    reflectorGet.mockReturnValue(undefined);

    interceptor.intercept(createContext(), createCallHandler('no-lock')).subscribe({
      next: (v) => {
        expect(v).toBe('no-lock');
        done();
      },
    });
  });

  it('calls withLock with resolved static key', (done) => {
    reflectorGet.mockReturnValue({ key: 'my-resource', duration: 3000 });

    interceptor.intercept(createContext(), createCallHandler('result')).subscribe({
      next: () => {
        expect(lockServiceWithLock).toHaveBeenCalledWith('my-resource', expect.any(Function), {
          duration: 3000,
          autoExtend: undefined,
          queue: undefined,
        });
        done();
      },
    });
  });

  // Legacy path: the interceptor can only see ExecutionContext.getArgs(), which
  // for HTTP is [req, res, next] — not the handler's parameters. This is exactly
  // why @Lock() no longer uses it. Documented here, not endorsed.
  it('resolves dynamic key from ExecutionContext.getArgs() (legacy semantics)', (done) => {
    reflectorGet.mockReturnValue({
      key: (args: unknown[]) => `booking:${(args[0] as { id: number }).id}`,
    });

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      next: () => {
        expect(lockServiceWithLock).toHaveBeenCalledWith('booking:42', expect.any(Function), {
          duration: undefined,
          autoExtend: undefined,
          queue: undefined,
        });
        done();
      },
    });
  });

  it('passes autoExtend option to withLock', (done) => {
    reflectorGet.mockReturnValue({ key: 'res', duration: 10000, autoExtend: true });

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      next: () => {
        expect(lockServiceWithLock).toHaveBeenCalledWith('res', expect.any(Function), {
          duration: 10000,
          autoExtend: true,
          queue: undefined,
        });
        done();
      },
    });
  });

  it('passes queue option to withLock', (done) => {
    reflectorGet.mockReturnValue({ key: 'res', duration: 5000, queue: true });

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      next: () => {
        expect(lockServiceWithLock).toHaveBeenCalledWith('res', expect.any(Function), {
          duration: 5000,
          autoExtend: undefined,
          queue: true,
        });
        done();
      },
    });
  });

  it('resolves string[] key from dynamic function', (done) => {
    reflectorGet.mockReturnValue({
      key: (_args: unknown[]) => ['seat:A1', 'seat:B2'],
    });

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      next: () => {
        expect(lockServiceWithLock).toHaveBeenCalledWith(
          ['seat:A1', 'seat:B2'],
          expect.any(Function),
          { duration: undefined, autoExtend: undefined, queue: undefined },
        );
        done();
      },
    });
  });

  it('re-throws LockAcquisitionException when onFail is "throw"', (done) => {
    reflectorGet.mockReturnValue({ key: 'res', onFail: 'throw' });
    lockServiceWithLock.mockRejectedValue(new LockAcquisitionException('res', 3, 750));

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(LockAcquisitionException);
        done();
      },
    });
  });

  it('returns undefined when onFail is "skip" and lock acquisition fails', (done) => {
    reflectorGet.mockReturnValue({ key: 'res', onFail: 'skip' });
    lockServiceWithLock.mockRejectedValue(new LockAcquisitionException('res', 3, 750));

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      next: (v) => {
        expect(v).toBeUndefined();
        done();
      },
      error: (err) => done(err),
    });
  });

  it('propagates non-lock errors even with onFail "skip"', (done) => {
    reflectorGet.mockReturnValue({ key: 'res', onFail: 'skip' });
    lockServiceWithLock.mockRejectedValue(new Error('db error'));

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      error: (err: Error) => {
        expect(err.message).toBe('db error');
        done();
      },
    });
  });

  it('defaults onFail to "throw" when not specified', (done) => {
    reflectorGet.mockReturnValue({ key: 'res' });
    lockServiceWithLock.mockRejectedValue(new LockAcquisitionException('res', 3, 750));

    interceptor.intercept(createContext(), createCallHandler()).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(LockAcquisitionException);
        done();
      },
    });
  });
});
