import { Controller, Post, Get, Body } from '@nestjs/common';
import { Lock, LockAcquisitionException } from 'nestjs-redlock';
import { BookingService, BookingResult } from './booking.service';

interface BookSeatDto {
  locationId: string;
  seatId: string;
  userId: string;
}

interface BookMultiDto {
  locationId: string;
  seatIds: string[];
  userId: string;
}

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  /**
   * Single-seat booking using @Lock() with a dynamic key.
   * If the seat is already being booked by another request, returns 409.
   */
  @Post()
  @Lock({
    key: (args: unknown[]) => {
      const dto = args[0] as BookSeatDto;
      return `seat:${dto.locationId}:${dto.seatId}`;
    },
    duration: 10_000,
    onFail: 'throw',
  })
  async bookSeat(@Body() dto: BookSeatDto): Promise<BookingResult | { error: string }> {
    try {
      return await this.bookingService.bookSeat(dto.locationId, dto.seatId, dto.userId);
    } catch (err) {
      if (err instanceof LockAcquisitionException) {
        return { error: `Seat ${dto.seatId} is currently being booked. Try again.` };
      }
      throw err;
    }
  }

  /**
   * Multi-seat booking using the service's lock groups API.
   * All seats are acquired atomically in sorted key order.
   */
  @Post('multi')
  async bookMultiple(@Body() dto: BookMultiDto): Promise<BookingResult[] | { error: string }> {
    try {
      return await this.bookingService.bookMultipleSeats(dto.locationId, dto.seatIds, dto.userId);
    } catch (err) {
      if (err instanceof LockAcquisitionException) {
        return { error: 'One or more seats are currently being booked. Try again.' };
      }
      throw err;
    }
  }

  @Get()
  listBookings(): BookingResult[] {
    return this.bookingService.listBookings();
  }
}
