import { AsyncLocalStorage } from 'async_hooks';
import { FencingToken } from './interfaces/fencing-token';

/**
 * The signal and fencing token for the `@Lock()`-decorated invocation
 * currently executing on this call stack.
 *
 * @example
 * const { signal, fencingToken } = getLockContext()!;
 */
export interface LockContext {
  /** The resource key(s) this invocation locked. */
  readonly resource: string | string[];
  /** Fires if auto-extend fails and the lock is presumed lost. */
  readonly signal: AbortSignal;
  /** Monotonically increasing per acquisition of this resource. */
  readonly fencingToken: FencingToken;
}

const storage = new AsyncLocalStorage<LockContext>();

/**
 * Runs `fn` with `context` available to any `getLockContext()` call made
 * during its execution (and its own nested async calls).
 *
 * @internal Used only by the `@Lock()` decorator's wrapper.
 */
export function runInLockContext<T>(context: LockContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/**
 * Reads the fencing token and AbortSignal for the `@Lock()`-decorated method
 * currently executing on this call stack. Returns `undefined` outside of any
 * `@Lock()`-decorated invocation — and, importantly, outside of one reached
 * via the decorator specifically: calling `LockService.withLock()` directly
 * does not populate this, since that callback already receives its own
 * `(signal, fencingToken)` parameters.
 *
 * Nested `@Lock()` calls: if a decorated method calls another decorated
 * method, `getLockContext()` inside the inner call reflects the inner lock's
 * own signal/token, not the outer one's, and reverts to the outer lock's
 * context once the inner call returns (standard AsyncLocalStorage nesting).
 * If the outer method needs its own values *after* making a nested call,
 * capture `getLockContext()` into a local variable before the nested call.
 *
 * @example
 * \@Lock({ key: (id: string) => `order:${id}`, autoExtend: true })
 * async processOrder(id: string): Promise<void> {
 *   const { signal, fencingToken } = getLockContext()!;
 *   await this.repo.applyWithFencing(id, fencingToken, signal);
 * }
 */
export function getLockContext(): LockContext | undefined {
  return storage.getStore();
}
