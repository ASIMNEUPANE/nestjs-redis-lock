import { Controller, Get } from '@nestjs/common';
import { ReportJobService } from './report-job.service';

@Controller('jobs')
export class ReportJobController {
  constructor(private readonly jobService: ReportJobService) {}

  @Get('history')
  getHistory() {
    return {
      instanceId: this.jobService.getInstanceId(),
      runs: this.jobService.getHistory(),
    };
  }
}
