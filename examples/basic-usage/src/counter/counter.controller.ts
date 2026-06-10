import { Controller, Get, Post } from '@nestjs/common';
import { Lock } from 'nestjs-redlock';
import { CounterService } from './counter.service';

@Controller('counter')
export class CounterController {
  constructor(private readonly counterService: CounterService) {}

  /**
   * Uses the @Lock() decorator — the interceptor acquires the lock before
   * the handler runs and releases it when the handler returns.
   */
  @Post('increment')
  @Lock({ key: 'counter-via-decorator', duration: 5000 })
  async increment(): Promise<{ value: number }> {
    const value = await this.counterService.increment();
    return { value };
  }

  @Get('value')
  getValue(): { value: number } {
    return { value: this.counterService.getValue() };
  }
}
