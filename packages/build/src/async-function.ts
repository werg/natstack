/**
 * AsyncFunction constructor utilities.
 *
 * Provides a typed constructor for creating async functions dynamically,
 * used for executing transformed ESM code.
 */

/**
 * The AsyncFunction constructor, extracted from an async function's prototype.
 * This allows creating async functions dynamically from strings.
 *
 * Usage:
 * ```typescript
 * const fn = new AsyncFunction("a", "b", "return a + b");
 * const result = await fn(1, 2); // 3
 * ```
 */
export const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as AsyncFunctionConstructor;

/**
 * Type for the AsyncFunction constructor.
 */
export interface AsyncFunctionConstructor {
  new (...args: string[]): (...args: unknown[]) => Promise<unknown>;
  (...args: string[]): (...args: unknown[]) => Promise<unknown>;
}
