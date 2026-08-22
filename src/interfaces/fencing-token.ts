/**
 * A monotonically increasing integer issued on every successful lock
 * acquisition (mutex, group, queue, semaphore, or read-write).
 *
 * Redlock itself provides no such value. Martin Kleppmann's well-known 2016
 * critique of the algorithm is that a paused or GC'd holder can still act
 * after its lock has already expired and a different holder has acquired
 * it — a fencing token is how the *protected resource* defends against
 * that: if your storage layer refuses any write whose token is not
 * strictly greater than the last one it accepted, a late write from an
 * expired holder is rejected even though the lock itself no longer
 * protects it.
 *
 * This package cannot enforce that check for you — it only guarantees the
 * token increases monotonically per resource. The protection only exists
 * if your storage layer (a database column, an API precondition) actually
 * compares it before accepting a write.
 *
 * @example
 * await lockService.withLock('inventory:sku-42', async (_signal, fencingToken) => {
 *   await db.query(
 *     'UPDATE inventory SET qty = $1, fencing_token = $2 ' +
 *       'WHERE sku = $3 AND fencing_token < $2',
 *     [newQty, fencingToken, 'sku-42'],
 *   );
 * });
 */
export type FencingToken = number;
