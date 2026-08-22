import { Injectable } from '@nestjs/common';

interface Seat {
  locationId: string;
  seatId: string;
  bookedBy: string | null;
}

/**
 * In-memory stand-in for a database.
 * In production this would be a TypeORM/Prisma repository.
 */
@Injectable()
export class SeatRepository {
  private readonly seats = new Map<string, Seat>();
  private readonly lastFence = new Map<string, number>();

  private key(locationId: string, seatId: string): string {
    return `${locationId}:${seatId}`;
  }

  async findSeat(locationId: string, seatId: string): Promise<Seat | null> {
    return this.seats.get(this.key(locationId, seatId)) ?? null;
  }

  /**
   * `fencingToken`, when passed, guards the write the same way a real
   * database would with `UPDATE ... WHERE fencing_token > :incoming`: a
   * write carrying a token that is not strictly newer than the last one
   * this seat accepted is rejected, protecting against a paused or GC'd
   * lock holder that wakes up and writes after a newer holder already won.
   */
  async bookSeat(
    locationId: string,
    seatId: string,
    userId: string,
    fencingToken?: number,
  ): Promise<Seat> {
    const key = this.key(locationId, seatId);
    const existing = this.seats.get(key);
    if (existing?.bookedBy) {
      throw new Error(`Seat ${seatId} at ${locationId} is already booked by ${existing.bookedBy}`);
    }

    if (fencingToken !== undefined) {
      const last = this.lastFence.get(key) ?? 0;
      if (fencingToken <= last) {
        throw new Error(
          `Stale write rejected for seat ${seatId} at ${locationId}: ` +
            `fencing token ${fencingToken} <= last accepted ${last}`,
        );
      }
      this.lastFence.set(key, fencingToken);
    }

    const seat: Seat = { locationId, seatId, bookedBy: userId };
    this.seats.set(key, seat);
    // Simulate async DB write
    await new Promise((r) => setTimeout(r, 20));
    return seat;
  }

  listBookings(): Seat[] {
    return Array.from(this.seats.values()).filter((s) => s.bookedBy !== null);
  }
}
