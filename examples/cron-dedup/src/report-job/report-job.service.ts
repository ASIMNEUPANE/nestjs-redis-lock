import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Lock } from 'nestjs-redlock';

interface JobRun {
  runAt: string;
  instanceId: string;
  durationMs: number;
}

/**
 * Demonstrates @Lock({ onFail: 'skip' }) on a @Cron handler.
 *
 * Without the lock, every NestJS instance in a cluster fires the job.
 * With the lock, only the first instance to acquire it runs the job;
 * the others silently skip their tick.
 */
@Injectable()
export class ReportJobService {
  private readonly logger = new Logger(ReportJobService.name);
  private readonly instanceId = `instance-${process.pid}`;
  private readonly history: JobRun[] = [];

  /**
   * Runs every 10 seconds. The lock key is fixed — all instances compete
   * for the same lock. onFail: 'skip' means losers skip silently.
   * duration: 15_000 (set in module) covers the job + safety margin.
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  @Lock({ key: 'cron:daily-report', onFail: 'skip' })
  async generateDailyReport(): Promise<void> {
    const start = Date.now();
    this.logger.log(`[${this.instanceId}] Starting daily report generation...`);

    // Simulate expensive work (aggregation query, file generation, email send)
    await new Promise((r) => setTimeout(r, 1_000));

    const durationMs = Date.now() - start;
    this.history.push({ runAt: new Date().toISOString(), instanceId: this.instanceId, durationMs });

    this.logger.log(`[${this.instanceId}] Report complete in ${durationMs}ms`);
  }

  getHistory(): JobRun[] {
    return this.history;
  }

  getInstanceId(): string {
    return this.instanceId;
  }
}
