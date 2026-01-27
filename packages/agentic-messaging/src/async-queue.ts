/**
 * AsyncQueue - A bidirectional buffer supporting both push (producer) and async iteration (consumer).
 *
 * This is a foundational utility for producer-consumer patterns in async code.
 * It allows producers to push values and consumers to iterate asynchronously,
 * handling backpressure naturally through the async iteration protocol.
 *
 * @example
 * ```typescript
 * const queue = new AsyncQueue<string>();
 *
 * // Producer (can be sync or async)
 * queue.push("hello");
 * queue.push("world");
 * queue.close();
 *
 * // Consumer (async iteration)
 * for await (const value of queue) {
 *   console.log(value); // "hello", "world"
 * }
 * ```
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private closeError: Error | null = null;

  /**
   * Push a value onto the queue.
   * If there's a waiting consumer, delivers immediately.
   * Otherwise, buffers the value for later consumption.
   *
   * @param value - The value to push
   */
  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  /**
   * Close the queue, optionally with an error.
   * Any waiting consumers will complete (or throw if error provided).
   * Future pushes will be ignored.
   *
   * @param error - Optional error to propagate to consumers
   */
  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error ?? null;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  /**
   * Check if the queue has been closed.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get the number of buffered values waiting to be consumed.
   */
  get length(): number {
    return this.values.length;
  }

  /**
   * Async iterator implementation.
   * Yields buffered values, then waits for new values until closed.
   * Throws if the queue was closed with an error.
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.closeError) throw this.closeError;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) {
        if (this.closeError) throw this.closeError;
        return;
      }
      yield next.value;
    }
  }
}

/**
 * Create a fanout utility for broadcasting values to multiple subscribers.
 *
 * Each subscriber gets its own AsyncQueue, and emit() pushes to all of them.
 * Subscriptions are registered synchronously to avoid missing events.
 *
 * @example
 * ```typescript
 * const fanout = createFanout<string>();
 *
 * // Subscribe (registers immediately)
 * const sub1 = fanout.subscribe();
 * const sub2 = fanout.subscribe();
 *
 * // Emit to all subscribers
 * fanout.emit("hello");
 *
 * // Iterate
 * for await (const value of sub1) { ... }
 * ```
 */
export function createFanout<T>() {
  const subscribers = new Set<AsyncQueue<T>>();

  return {
    /**
     * Emit a value to all current subscribers.
     */
    emit(value: T): void {
      for (const q of subscribers) q.push(value);
    },

    /**
     * Close all subscribers, optionally with an error.
     */
    close(error?: Error): void {
      for (const q of subscribers) q.close(error);
      subscribers.clear();
    },

    /**
     * Subscribe to the fanout.
     * The subscription is registered immediately (synchronously) when called,
     * ensuring no messages are missed between subscribe() and the first await.
     *
     * The returned iterator automatically cleans up when:
     * - Iteration completes normally
     * - An error occurs during iteration
     * - The consumer breaks out of a for-await loop (calls return())
     *
     * @returns An async iterator that yields emitted values
     */
    subscribe(): AsyncIterableIterator<T> {
      const q = new AsyncQueue<T>();
      // Register the subscription IMMEDIATELY, not when iteration starts
      subscribers.add(q);

      const cleanup = () => {
        subscribers.delete(q);
        q.close();
      };

      // Get a single iterator from the queue to use for all next() calls
      const queueIterator = q[Symbol.asyncIterator]();

      // Return an async iterator that yields from the queue with proper cleanup
      const iterator: AsyncIterableIterator<T> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<T>> {
          try {
            const result = await queueIterator.next();
            if (result.done) {
              cleanup();
            }
            return result;
          } catch (err) {
            cleanup();
            throw err;
          }
        },
        async return(value?: T): Promise<IteratorResult<T>> {
          cleanup();
          return { value: value as T, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<T>> {
          cleanup();
          throw err;
        },
      };

      return iterator;
    },

    /**
     * Get the current number of subscribers.
     */
    get subscriberCount(): number {
      return subscribers.size;
    },
  };
}
