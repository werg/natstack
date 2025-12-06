/**
 * Contract for the typed-rpc-child panel.
 *
 * This single object defines the entire parent-child interface:
 * - What RPC methods the child exposes
 * - What events the child emits
 * - What events the parent sends (if any)
 *
 * Both parent and child import this contract for full type safety.
 */

import { z, defineContract } from "@natstack/core";

// =============================================================================
// RPC Methods (what the child exposes)
// =============================================================================

export interface RpcDemoChildApi {
  ping(): Promise<string>;
  echo(message: string): Promise<string>;
  getCounter(): Promise<number>;
  incrementCounter(amount?: number): Promise<number>;
  resetCounter(): Promise<void>;
  getInfo(): Promise<{ panelId: string; counter: number }>;
}

// =============================================================================
// Contract Definition
// =============================================================================

/**
 * The contract for typed-rpc-child panel.
 *
 * Usage:
 * - Parent: `panel.createChildWithContract(rpcDemoContract)`
 * - Child: `panel.getParentWithContract(rpcDemoContract)`
 */
export const rpcDemoContract = defineContract({
  source: "panels/typed-rpc-child",

  child: {
    // RPC methods the child exposes (interface for types, phantom at runtime)
    methods: {} as RpcDemoChildApi,

    // Events the child emits to parent (zod schemas for validation)
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

  // Parent side (optional - only if parent sends events to child)
  // parent: {
  //   emits: {
  //     "theme-changed": z.object({ theme: z.enum(["light", "dark"]) }),
  //   },
  // },
});

// Re-export for backwards compatibility with existing code
export type RpcDemoChildEvents = typeof rpcDemoContract extends { child: { emits: infer E } }
  ? { [K in keyof E]: E[K] extends z.ZodType<infer T> ? T : never }
  : never;
