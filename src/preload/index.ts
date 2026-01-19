import { ipcRenderer } from "electron";
import type { RpcMessage, RpcRequest, RpcResponse } from "@natstack/rpc";
import type { StreamTextChunkEvent, StreamTextEndEvent } from "../shared/ipc/types.js";

// =============================================================================
// Shell RPC Transport
// =============================================================================
// The shell uses a simplified transport that only communicates with main.
// Unlike panels, shell doesn't need panel-to-panel MessagePort connections.

type AnyMessageHandler = (fromId: string, message: unknown) => void;

type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: AnyMessageHandler) => () => void;
};

function createShellTransport(): ShellTransportBridge {
  const listeners = new Set<AnyMessageHandler>();
  const bufferedMessages: Array<{ fromId: string; message: RpcMessage }> = [];
  let transportReady = false;
  let flushScheduled = false;

  const deliver = (fromId: string, message: RpcMessage) => {
    if (!transportReady) {
      bufferedMessages.push({ fromId, message });
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    for (const listener of listeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("Error in shell transport message handler:", error);
      }
    }
  };

  // Handle events from main (event subscriptions)
  ipcRenderer.on("shell-rpc:event", (_event, payload: RpcMessage) => {
    deliver("main", payload);
  });

  // Handle AI streaming events
  ipcRenderer.on("ai:stream-text-chunk", (_event, payload: StreamTextChunkEvent) => {
    deliver("main", {
      type: "event",
      fromId: "main",
      event: "ai:stream-text-chunk",
      payload: { streamId: payload.streamId, chunk: payload.chunk },
    });
  });

  ipcRenderer.on("ai:stream-text-end", (_event, payload: StreamTextEndEvent) => {
    deliver("main", {
      type: "event",
      fromId: "main",
      event: "ai:stream-text-end",
      payload: { streamId: payload.streamId },
    });
  });

  const send: ShellTransportBridge["send"] = async (targetId, message) => {
    const rpcMessage = message as RpcMessage;
    if (
      !rpcMessage ||
      typeof rpcMessage !== "object" ||
      typeof (rpcMessage as { type?: unknown }).type !== "string"
    ) {
      throw new Error("Invalid RPC message");
    }

    // Shell can only send to main
    if (targetId !== "main") {
      throw new Error(`Shell can only send RPC messages to 'main', not '${targetId}'`);
    }

    if (rpcMessage.type === "request") {
      try {
        const response = (await ipcRenderer.invoke("shell-rpc:call", rpcMessage)) as RpcResponse;
        deliver("main", response);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        deliver("main", {
          type: "response",
          requestId: (rpcMessage as RpcRequest).requestId,
          error: err,
        });
      }
      return;
    }
  };

  return {
    send,
    onMessage(handler) {
      listeners.add(handler);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          transportReady = true;
          for (const buffered of bufferedMessages) {
            for (const listener of listeners) {
              try {
                listener(buffered.fromId, buffered.message);
              } catch (error) {
                console.error("Error delivering buffered shell transport message:", error);
              }
            }
          }
          bufferedMessages.length = 0;
        });
      }
      return () => listeners.delete(handler);
    },
  };
}

// Create the shell transport
const shellTransport = createShellTransport();

// Set up NatStack globals for @natstack/runtime packages
// The shell is identified as "shell" and has a fixed session
// Note: Other globals (__natstackId, etc.) are declared by @natstack/runtime
declare global {
  var __natstackTransport: ShellTransportBridge | undefined;
}

// Set globals directly (shell uses contextIsolation: false)
globalThis.__natstackTransport = shellTransport;
globalThis.__natstackId = "shell";
globalThis.__natstackContextId = "shell-context";
globalThis.__natstackKind = "shell";
