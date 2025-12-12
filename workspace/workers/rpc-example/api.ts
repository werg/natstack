/**
 * Typed RPC API for the example worker.
 * Export this so parent panels can import it for type safety.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RpcExampleWorkerApi extends Record<string, (...args: any[]) => any> {
  ping(): Promise<string>;
  echo(message: string): Promise<string>;
  getCounter(): Promise<number>;
  incrementCounter(amount?: number): Promise<number>;
  resetCounter(): Promise<void>;
  getWorkerInfo(): Promise<{
    workerId: string;
    counter: number;
    uptime: number;
  }>;
  computeSum(numbers: number[]): Promise<number>;
}

/**
 * Events emitted by this worker.
 */
export interface RpcExampleWorkerEvents {
  "counter-changed": { value: number; previousValue: number };
  "reset": { timestamp: string };
  "ping-received": { count: number };
}
