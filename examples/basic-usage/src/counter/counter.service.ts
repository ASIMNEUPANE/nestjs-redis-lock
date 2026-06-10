import { Injectable } from '@nestjs/common';
import { LockService } from 'nestjs-redlock';

/**
 * Demonstrates using LockService.withLock() directly in a service.
 * The counter is intentionally held in-memory to show that concurrent
 * increments don't corrupt the value when protected by a lock.
 */
@Injectable()
export class CounterService {
  private value = 0;

  constructor(private readonly lockService: LockService) {}

  async increment(): Promise<number> {
    return this.lockService.withLock('counter', async () => {
      // Simulate async work (e.g. read-modify-write to a database)
      await new Promise((r) => setTimeout(r, 10));
      this.value++;
      return this.value;
    });
  }

  getValue(): number {
    return this.value;
  }
}
