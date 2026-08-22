import { Injectable, Logger } from '@nestjs/common';
import { LockService } from 'nestjs-redlock';
import { SeatRepository } from './seat.repository';

export interface BookingResult {
  locationId: string;
  seatId: string;
  userId: string;
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly lockService: LockService,
    private readonly seatRepo: SeatRepository,
  ) {}

  /**
   * Books a single seat using a dynamic per-seat lock.
   * Lock key: `seat:{locationId}:{seatId}` — scoped so different seats
   * don't block each other.
   *
   * The callback's `fencingToken` is passed through to the repository write,
   * which rejects it if a newer holder already booked this seat — see
   * {@link SeatRepository.bookSeat}.
   */
  async bookSeat(locationId: string, seatId: string, userId: string): Promise<BookingResult> {
    const resource = `seat:${locationId}:${seatId}`;

    return this.lockService.withLock(resource, async (_signal, fencingToken) => {
      const seat = await this.seatRepo.bookSeat(locationId, seatId, userId, fencingToken);
      return { locationId: seat.locationId, seatId: seat.seatId, userId: seat.bookedBy! };
    });
  }

  /**
   * Books multiple seats atomically using lock groups.
   * Seats are acquired in sorted order to prevent deadlocks when two
   * concurrent requests try to book the same seats in different order.
   *
   * Wrapped in an exclusive `mode: 'write'` hold on the location's seat map
   * so a bulk booking can't interleave with a concurrent
   * {@link getAvailability} read seeing some, but not all, of these seats
   * updated. Lock groups can't take `mode` themselves (mutually exclusive),
   * so the write lock uses its own single coordinating resource.
   */
  async bookMultipleSeats(
    locationId: string,
    seatIds: string[],
    userId: string,
  ): Promise<BookingResult[]> {
    return this.lockService.withLock(
      `seatmap:${locationId}`,
      async () => {
        // Lock keys for all seats — LockService sorts them alphabetically
        const resources = seatIds.map((seatId) => `seat:${locationId}:${seatId}`);

        return this.lockService.withLock(resources, async () => {
          const results: BookingResult[] = [];
          for (const seatId of seatIds) {
            const seat = await this.seatRepo.bookSeat(locationId, seatId, userId);
            results.push({
              locationId: seat.locationId,
              seatId: seat.seatId,
              userId: seat.bookedBy!,
            });
          }
          return results;
        });
      },
      { mode: 'write' },
    );
  }

  /**
   * Reads the seat map for a location under a shared `mode: 'read'` hold —
   * any number of concurrent viewers are allowed, but none run while
   * {@link bookMultipleSeats}'s exclusive write is in progress, so a viewer
   * never observes a bulk booking half-applied.
   */
  async getAvailability(locationId: string): Promise<BookingResult[]> {
    return this.lockService.withLock(
      `seatmap:${locationId}`,
      async () => {
        return this.seatRepo
          .listBookings()
          .filter((s) => s.locationId === locationId)
          .map((s) => ({ locationId: s.locationId, seatId: s.seatId, userId: s.bookedBy! }));
      },
      { mode: 'read' },
    );
  }

  /**
   * Confirms payment through a (simulated) downstream gateway that can only
   * handle a limited number of concurrent calls per location.
   * `maxConcurrent: 3` admits up to 3 callers at once instead of one —
   * ordering alone (a plain queue) can't provide that ceiling, so this rides
   * the semaphore rather than `queue: true`.
   */
  async confirmPayment(locationId: string, bookingId: string): Promise<{ confirmed: true }> {
    return this.lockService.withLock(
      `payment-gateway:${locationId}`,
      async () => {
        // Simulate a slow call to an external payment provider.
        await new Promise((r) => setTimeout(r, 200));
        this.logger.log(`Payment confirmed for booking ${bookingId} at ${locationId}`);
        return { confirmed: true as const };
      },
      { maxConcurrent: 3, duration: 5000 },
    );
  }

  listBookings(): BookingResult[] {
    return this.seatRepo
      .listBookings()
      .map((s) => ({ locationId: s.locationId, seatId: s.seatId, userId: s.bookedBy! }));
  }
}
