/**
 * RPC Example Worker
 *
 * Demonstrates worker-to-panel RPC communication.
 * This worker exposes a typed API that can be called by the parent panel.
 */

import { rpc, parent, setTitle } from "@natstack/runtime";

// Internal state
let counter = 0;
let pingCount = 0;
const startTime = Date.now();

/**
 * Log a message (visible in main process console).
 */
function log(message: string): void {
  console.log(`[RpcExampleWorker] ${message}`);
}

/**
 * Emit an event to the parent panel.
 * Uses the new `parent` handle from worker-runtime (noop if no parent).
 */
function emitToParent(event: string, payload: unknown): void {
  void parent.emit(event, payload);
  log(`Emitted '${event}' to parent: ${JSON.stringify(payload)}`);
}

// Set a descriptive title
void setTitle("RPC Example Worker");

log("Worker starting...");
log(`Worker ID: ${rpc.selfId}`);

// Expose RPC methods
rpc.expose({
  async ping(): Promise<string> {
    pingCount++;
    log(`ping() called (count: ${pingCount})`);

    // Emit event to parent
    emitToParent("ping-received", { count: pingCount });

    return "pong";
  },

  async echo(message): Promise<string> {
    const msg = message as string;
    log(`echo("${msg}") called`);
    return `Echo from worker: ${msg}`;
  },

  async getCounter(): Promise<number> {
    log(`getCounter() called, returning ${counter}`);
    return counter;
  },

  async incrementCounter(amount): Promise<number> {
    const amt = (amount as number | undefined) ?? 1;
    const previousValue = counter;
    counter += amt;
    log(`incrementCounter(${amt}) called, new value: ${counter}`);

    // Emit event to parent
    emitToParent("counter-changed", { value: counter, previousValue });

    return counter;
  },

  async resetCounter(): Promise<void> {
    counter = 0;
    log("resetCounter() called");

    // Emit event to parent
    emitToParent("reset", { timestamp: new Date().toISOString() });
  },

  async getWorkerInfo(): Promise<{
    workerId: string;
    counter: number;
    uptime: number;
  }> {
    const info = {
      workerId: rpc.selfId,
      counter,
      uptime: Date.now() - startTime,
    };
    log(`getWorkerInfo() called: ${JSON.stringify(info)}`);
    return info;
  },

  async computeSum(numbers): Promise<number> {
    const nums = numbers as number[];
    const sum = nums.reduce((acc, n) => acc + n, 0);
    log(`computeSum([${nums.join(", ")}]) = ${sum}`);
    return sum;
  },
});

// Listen for events from parent
rpc.onEvent("parentMessage", (fromId, payload) => {
  log(`Received 'parentMessage' from ${fromId}: ${JSON.stringify(payload)}`);
});

log("Worker ready - RPC API exposed");
