/**
 * Injection token for LockModule configuration options.
 *
 * @example
 * \@Inject(LOCK_MODULE_OPTIONS)
 * private readonly options: LockModuleOptions
 */
export const LOCK_MODULE_OPTIONS = Symbol('LOCK_MODULE_OPTIONS');

/**
 * Metadata key used by @Lock() decorator and LockInterceptor
 * to store and retrieve LockDecoratorOptions on route handlers.
 *
 * @example
 * Reflector.get(LOCK_METADATA_KEY, context.getHandler())
 */
export const LOCK_METADATA_KEY = Symbol('LOCK_METADATA_KEY');
