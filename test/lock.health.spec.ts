import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckError } from '@nestjs/terminus';
import { LockHealthIndicator } from '../src/lock.health';
import { LockService } from '../src/lock.service';

const mockRelease = jest.fn().mockResolvedValue(undefined);
const mockLock = {
  resources: ['lock:__health-check__'],
  expiration: Date.now() + 1000,
  release: mockRelease,
};

const mockTryLock = jest.fn();

describe('LockHealthIndicator', () => {
  let indicator: LockHealthIndicator;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTryLock.mockResolvedValue(mockLock);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LockHealthIndicator,
        { provide: LockService, useValue: { tryLock: mockTryLock } },
      ],
    }).compile();

    indicator = module.get(LockHealthIndicator);
  });

  it('returns healthy status when lock can be acquired and released', async () => {
    const result = await indicator.isHealthy('redis-lock');
    expect(result).toEqual({ 'redis-lock': { status: 'up' } });
    expect(mockTryLock).toHaveBeenCalledWith('__health-check__', 1000);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns healthy status with custom key', async () => {
    const result = await indicator.isHealthy('my-lock-check');
    expect(result).toEqual({ 'my-lock-check': { status: 'up' } });
  });

  it('uses default key "redis-lock" when none provided', async () => {
    const result = await indicator.isHealthy();
    expect(result).toHaveProperty('redis-lock');
  });

  it('returns healthy when tryLock returns null (another process holds sentinel lock)', async () => {
    mockTryLock.mockResolvedValueOnce(null);
    const result = await indicator.isHealthy('redis-lock');
    expect(result).toEqual({ 'redis-lock': { status: 'up' } });
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('throws HealthCheckError when tryLock throws', async () => {
    mockTryLock.mockRejectedValueOnce(new Error('redis connection refused'));

    await expect(indicator.isHealthy('redis-lock')).rejects.toBeInstanceOf(HealthCheckError);
  });

  it('HealthCheckError contains the failure reason', async () => {
    mockTryLock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const err = await indicator.isHealthy('redis-lock').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HealthCheckError);
    expect((err as HealthCheckError).message).toBe('LockService is unhealthy');
  });

  it('remains healthy even when release fails (1s lock expires naturally)', async () => {
    mockRelease.mockRejectedValueOnce(new Error('already released'));
    const result = await indicator.isHealthy('redis-lock');
    expect(result).toEqual({ 'redis-lock': { status: 'up' } });
  });
});
