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
  private lastAppliedFence = 0;

  constructor(private readonly lockService: LockService) {}

  async increment(): Promise<number> {
    return this.lockService.withLock('counter', async () => {
      // Simulate async work (e.g. read-modify-write to a database)
      await new Promise((r) => setTimeout(r, 10));
      this.value++;
      return this.value;
    });
  }

  /**
   * Same critical section as {@link increment}, but demonstrates the
   * programmatic API's `(signal, fencingToken)` callback: `autoExtend` keeps
   * the lock alive for the duration of the (simulated) slow write, `signal`
   * lets the callback bail out promptly if auto-extend ever loses the race,
   * and `fencingToken` guards the write itself — a paused holder that wakes
   * up after a newer holder has already applied its write gets rejected
   * instead of silently corrupting `value`.
   */
  async incrementWithFencing(): Promise<{ value: number; fencingToken: number }> {
    return this.lockService.withLock(
      'counter',
      async (signal, fencingToken) => {
        await new Promise((r) => setTimeout(r, 10));

        if (signal.aborted) {
          throw new Error('Lock was lost mid-callback — aborting before writing');
        }
        if (fencingToken <= this.lastAppliedFence) {
          // Would only happen if a stale, expired holder resumed after a
          // newer one already committed — see README's "Fencing tokens" note.
          throw new Error(
            `Stale fencing token ${fencingToken} (last applied: ${this.lastAppliedFence})`,
          );
        }

        this.lastAppliedFence = fencingToken;
        this.value++;
        return { value: this.value, fencingToken };
      },
      { autoExtend: true, duration: 5000 },
    );
  }

  getValue(): number {
    return this.value;
  }
}
