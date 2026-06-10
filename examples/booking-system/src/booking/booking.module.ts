import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { SeatRepository } from './seat.repository';

@Module({
  controllers: [BookingController],
  providers: [BookingService, SeatRepository],
})
export class BookingModule {}
