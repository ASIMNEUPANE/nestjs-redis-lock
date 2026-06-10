import { Module } from '@nestjs/common';
import { ReportJobService } from './report-job.service';
import { ReportJobController } from './report-job.controller';

@Module({
  providers: [ReportJobService],
  controllers: [ReportJobController],
})
export class ReportJobModule {}
