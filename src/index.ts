// The redlock Lock type — exported as RedlockLock to avoid collision with the Lock decorator
export type { Lock as RedlockLock } from 'redlock';

export { Lock } from './lock.decorator';
export { LockModule } from './lock.module';
export { LockService } from './lock.service';
export { LockInterceptor } from './lock.interceptor';
export { LockHealthIndicator } from './lock.health';

export { LockAcquisitionException } from './exceptions/lock-acquisition.exception';
export { LockExtendException } from './exceptions/lock-extend.exception';

export { LockEvent } from './lock.events';
export type { LockEventType, LockEventPayloads } from './lock.events';

export type { LockModuleOptions, LockModuleAsyncOptions } from './interfaces/lock-module-options';
export type { LockDecoratorOptions } from './interfaces/lock-options';
export type { LockCallOptions } from './interfaces/lock-call-options';
export type { FencingToken } from './interfaces/fencing-token';

export { LOCK_MODULE_OPTIONS, LOCK_METADATA_KEY } from './constants';
