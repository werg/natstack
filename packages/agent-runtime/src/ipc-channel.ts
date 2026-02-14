/**
 * Agent IPC Channel Abstraction
 *
 * Provides a unified IPC interface for agents running in either
 * Electron's utilityProcess or Node.js child_process.fork().
 *
 * Key responsibility: centralizes the Electron `{data: ...}` unwrapping
 * that was previously duplicated in 3 places (waitForInit, transport,
 * shutdown listener). Consumers receive clean (unwrapped) messages
 * regardless of runtime.
 */

/**
 * Abstraction over Electron parentPort / Node.js fork IPC.
 * Consumers receive clean (unwrapped) messages regardless of runtime.
 */
export interface AgentIpcChannel {
  postMessage(msg: unknown): void;
  on(event: "message", handler: (msg: unknown) => void): void;
  removeListener(event: "message", handler: (msg: unknown) => void): void;
  ref?(): void;
  unref?(): void;
}

/**
 * Detect and return the appropriate IPC channel for the current runtime.
 *
 * - Electron utilityProcess: uses `process.parentPort`, unwraps `{data: ...}` envelopes
 * - Node.js fork: uses `process.send()` / `process.on("message")`
 *
 * @throws Error if no IPC channel is available
 */
export function getAgentIpcChannel(): AgentIpcChannel {
  // Try Electron's parentPort first
  const parentPort = (process as unknown as { parentPort?: any }).parentPort;
  if (parentPort) {
    // Electron utilityProcess wraps messages in { data: ... } — unwrap transparently.
    // Track wrapped→original handler mapping so removeListener works correctly.
    const handlerMap = new WeakMap<Function, Function>();
    return {
      postMessage: (msg) => parentPort.postMessage(msg),
      on: (event, handler) => {
        const wrapped = (msg: unknown) => {
          const unwrapped =
            msg && typeof msg === "object" && "data" in msg
              ? (msg as { data: unknown }).data
              : msg;
          handler(unwrapped);
        };
        handlerMap.set(handler, wrapped);
        parentPort.on(event, wrapped);
      },
      removeListener: (event, handler) => {
        const wrapped = handlerMap.get(handler) ?? handler;
        parentPort.removeListener(event, wrapped);
        handlerMap.delete(handler);
      },
      ref: () => parentPort.ref?.(),
      unref: () => parentPort.unref?.(),
    };
  }

  // Node.js child_process.fork()
  if (typeof process.send === "function") {
    return {
      postMessage: (msg) => process.send!(msg),
      on: (event, handler) => {
        process.on(event, handler);
      },
      removeListener: (event, handler) => {
        process.removeListener(event, handler);
      },
      ref: () => (process as any).channel?.ref?.(),
      unref: () => (process as any).channel?.unref?.(),
    };
  }

  throw new Error(
    "No IPC channel available: agent must run in Electron utilityProcess or child_process.fork()"
  );
}
