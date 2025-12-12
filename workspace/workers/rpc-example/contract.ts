/**
 * Contract for the RPC Example Worker.
 * Defines the typed interface between parent panels and this worker.
 */

import { z, defineContract } from "@natstack/core";

/**
 * RPC methods exposed by this worker.
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
 * Contract defining the worker's interface.
 */
export const rpcExampleWorkerContract = defineContract({
  source: "workers/rpc-example",
  child: {
    methods: {} as RpcExampleWorkerApi,
    emits: {
      "counter-changed": z.object({
        value: z.number(),
        previousValue: z.number(),
      }),
      "ping-received": z.object({
        count: z.number(),
      }),
      "reset": z.object({
        timestamp: z.string(),
      }),
    },
  },
});
