import { Module } from '@nestjs/common';
import { LockModule } from 'nestjs-redlock';
import Redis from 'ioredis';
import { BookingModule } from './booking/booking.module';

@Module({
  imports: [
    LockModule.register({
      clients: [new Redis({ host: 'localhost', port: 6379 })],
      // Hold seat locks for 10 seconds — enough for a DB write
      duration: 10_000,
      retryCount: 0, // Fail-fast: don't queue competing requests
    }),
    BookingModule,
  ],
})
export class AppModule {}
