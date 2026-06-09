import { DynamicModule, Global, Module } from '@nestjs/common';
import { LOCK_MODULE_OPTIONS } from './constants';
import { LockModuleOptions, LockModuleAsyncOptions } from './interfaces/lock-module-options';
import { LockService } from './lock.service';
import { LockInterceptor } from './lock.interceptor';

/**
 * NestJS module for distributed Redis locking.
 * Register once in AppModule — LockService is available everywhere via @Global().
 *
 * @example
 * // Synchronous registration
 * \@Module({
 *   imports: [
 *     LockModule.register({
 *       clients: [new Redis(process.env.REDIS_URL)],
 *       duration: 5000,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * @example
 * // Async registration with ConfigService
 * \@Module({
 *   imports: [
 *     LockModule.registerAsync({
 *       imports: [ConfigModule],
 *       inject: [ConfigService],
 *       useFactory: (config: ConfigService) => ({
 *         clients: [new Redis(config.get('REDIS_URL'))],
 *       }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 */
@Global()
@Module({})
export class LockModule {
  /**
   * Synchronous module registration.
   *
   * @example
   * LockModule.register({ clients: [new Redis()] })
   */
  static register(options: LockModuleOptions): DynamicModule {
    return {
      module: LockModule,
      providers: [
        {
          provide: LOCK_MODULE_OPTIONS,
          useValue: options,
        },
        LockService,
        LockInterceptor,
      ],
      exports: [LockService, LockInterceptor],
    };
  }

  /**
   * Async module registration supporting dependency injection in the factory.
   *
   * @example
   * LockModule.registerAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({ clients: [new Redis(config.get('REDIS_URL'))] }),
   * })
   */
  static registerAsync(asyncOptions: LockModuleAsyncOptions): DynamicModule {
    return {
      module: LockModule,
      imports: asyncOptions.imports ?? [],
      providers: [
        {
          provide: LOCK_MODULE_OPTIONS,
          useFactory: asyncOptions.useFactory,
          inject: asyncOptions.inject ?? [],
        },
        LockService,
        LockInterceptor,
      ],
      exports: [LockService, LockInterceptor],
    };
  }
}
