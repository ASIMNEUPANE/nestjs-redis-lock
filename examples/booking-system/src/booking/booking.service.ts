import { Injectable } from '@nestjs/common';
import { LockService } from 'nestjs-redlock';
import { SeatRepository } from './seat.repository';

export interface BookingResult {
  locationId: string;
  seatId: string;
  userId: string;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly lockService: LockService,
    private readonly seatRepo: SeatRepository,
  ) {}

  /**
   * Books a single seat using a dynamic per-seat lock.
   * Lock key: `seat:{locationId}:{seatId}` — scoped so different seats
   * don't block each other.
   */
  async bookSeat(locationId: string, seatId: string, userId: string): Promise<BookingResult> {
    const resource = `seat:${locationId}:${seatId}`;

    return this.lockService.withLock(resource, async () => {
      const seat = await this.seatRepo.bookSeat(locationId, seatId, userId);
      return { locationId: seat.locationId, seatId: seat.seatId, userId: seat.bookedBy! };
    });
  }

  /**
   * Books multiple seats atomically using lock groups.
   * Seats are acquired in sorted order to prevent deadlocks when two
   * concurrent requests try to book the same seats in different order.
   */
  async bookMultipleSeats(
    locationId: string,
    seatIds: string[],
    userId: string,
  ): Promise<BookingResult[]> {
    // Lock keys for all seats — LockService sorts them alphabetically
    const resources = seatIds.map((seatId) => `seat:${locationId}:${seatId}`);

    return this.lockService.withLock(resources, async () => {
      const results: BookingResult[] = [];
      for (const seatId of seatIds) {
        const seat = await this.seatRepo.bookSeat(locationId, seatId, userId);
        results.push({ locationId: seat.locationId, seatId: seat.seatId, userId: seat.bookedBy! });
      }
      return results;
    });
  }

  listBookings(): BookingResult[] {
    return this.seatRepo
      .listBookings()
      .map((s) => ({ locationId: s.locationId, seatId: s.seatId, userId: s.bookedBy! }));
  }
}
