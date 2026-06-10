import { Module } from '@nestjs/common';
import { LockModule } from 'nestjs-redlock';
import Redis from 'ioredis';
import { CounterModule } from './counter/counter.module';

@Module({
  imports: [
    LockModule.register({
      clients: [new Redis({ host: 'localhost', port: 6379 })],
      duration: 5000,
      retryCount: 3,
    }),
    CounterModule,
  ],
})
export class AppModule {}
