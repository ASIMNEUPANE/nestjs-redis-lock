import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LockModule } from 'nestjs-redlock';
import Redis from 'ioredis';
import { ReportJobModule } from './report-job/report-job.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    LockModule.register({
      clients: [new Redis({ host: 'localhost', port: 6379 })],
      // Lock TTL slightly longer than the job interval to ensure only one
      // instance runs the job per tick even if the job itself is slow.
      duration: 15_000,
      retryCount: 0, // Don't retry — skip this tick, run next tick
    }),
    ReportJobModule,
  ],
})
export class AppModule {}
