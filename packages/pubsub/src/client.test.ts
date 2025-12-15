/**
 * Tests for the PubSub client.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { connect, type PubSubClient } from "./client.js";
import { PubSubError } from "./types.js";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { Server } from "http";
import { createServer } from "http";

// Mock WebSocket for browser environment
const MockWebSocket = vi.fn() as unknown as typeof WebSocket & ReturnType<typeof vi.fn>;
// Set WebSocket.OPEN constant
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
vi.stubGlobal("WebSocket", MockWebSocket);

describe("PubSubClient", () => {
  let wss: WebSocketServer;
  let httpServer: Server;
  let port: number;

  beforeEach(async () => {
    // Create a mock server
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });

    // Find an available port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => {
        const addr = httpServer.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });

    // Reset mock
    MockWebSocket.mockReset();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  describe("connect", () => {
    it("builds correct URL with query parameters", () => {
      // Track the URL that would be passed to WebSocket
      let capturedUrl: string | null = null;

      MockWebSocket.mockImplementation((url: string) => {
        capturedUrl = url;
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
      });

      connect(`ws://127.0.0.1:${port}`, "test-token", { channel: "my-channel" });

      expect(capturedUrl).not.toBeNull();
      const url = new URL(capturedUrl!);
      expect(url.searchParams.get("token")).toBe("test-token");
      expect(url.searchParams.get("channel")).toBe("my-channel");
    });

    it("includes sinceId when provided", () => {
      let capturedUrl: string | null = null;

      MockWebSocket.mockImplementation((url: string) => {
        capturedUrl = url;
        return {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
      });

      connect(`ws://127.0.0.1:${port}`, "test-token", {
        channel: "my-channel",
        sinceId: 42,
      });

      expect(capturedUrl).not.toBeNull();
      const url = new URL(capturedUrl!);
      expect(url.searchParams.get("sinceId")).toBe("42");
    });
  });

  describe("ready()", () => {
    it("resolves when ready message is received", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Simulate server sending ready
      setTimeout(() => {
        onmessage?.({ data: JSON.stringify({ kind: "ready" }) });
      }, 10);

      await expect(client.ready(1000)).resolves.toBeUndefined();
    });

    it("rejects on timeout", async () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      await expect(client.ready(50)).rejects.toThrow("ready timeout");
    });
  });

  describe("publish()", () => {
    it("sends message with ref for correlation", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: mockSend,
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Send ready
      setTimeout(() => {
        onmessage?.({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      // Start publish
      const publishPromise = client.publish("test-type", { data: "hello" });

      // Verify send was called
      expect(mockSend).toHaveBeenCalled();
      const sentMsg = JSON.parse(mockSend.mock.calls[0][0] as string) as {
        action: string;
        type: string;
        payload: object;
        persist: boolean;
        ref: number;
      };
      expect(sentMsg.action).toBe("publish");
      expect(sentMsg.type).toBe("test-type");
      expect(sentMsg.payload).toEqual({ data: "hello" });
      expect(sentMsg.persist).toBe(true);
      expect(sentMsg.ref).toBe(1);

      // Simulate response with ref
      onmessage?.({
        data: JSON.stringify({
          kind: "persisted",
          id: 123,
          ref: 1,
          type: "test-type",
          payload: { data: "hello" },
          senderId: "me",
          ts: Date.now(),
        }),
      });

      const id = await publishPromise;
      expect(id).toBe(123);
    });

    it("rejects when not connected", async () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 0, // Not open
        OPEN: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      await expect(client.publish("test", {})).rejects.toThrow("not connected");
    });
  });

  describe("onError()", () => {
    it("calls error handler on server error with PubSubError", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      const errorHandler = vi.fn();
      client.onError(errorHandler);

      // Simulate server error
      onmessage?.({
        data: JSON.stringify({ kind: "error", error: "test error" }),
      });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const error = errorHandler.mock.calls[0][0] as PubSubError;
      expect(error).toBeInstanceOf(PubSubError);
      expect(error.message).toBe("test error");
      expect(error.code).toBe("server");
    });

    it("rejects pending publish when error has matching ref", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;
      const mockSend = vi.fn();

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: mockSend,
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      // Send ready
      setTimeout(() => {
        onmessage?.({ data: JSON.stringify({ kind: "ready" }) });
      }, 5);
      await client.ready();

      // Start publish
      const publishPromise = client.publish("test-type", { data: "hello" });

      // Simulate server error with ref
      onmessage?.({
        data: JSON.stringify({ kind: "error", error: "payload not serializable", ref: 1 }),
      });

      // Publish should reject with PubSubError
      await expect(publishPromise).rejects.toThrow(PubSubError);
      await expect(publishPromise).rejects.toThrow("payload not serializable");

      try {
        await publishPromise;
      } catch (e) {
        expect((e as PubSubError).code).toBe("validation");
      }
    });

    it("sets validation code for validation errors", async () => {
      let onmessage: ((event: { data: string }) => void) | null = null;

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null,
          _onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null,
          onclose: null,
          close: vi.fn(),
          send: vi.fn(),
        };
        Object.defineProperty(ws, "onmessage", {
          get: () => ws._onmessage,
          set: (handler: (event: { data: string }) => void) => {
            ws._onmessage = handler;
            onmessage = handler;
          },
        });
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      const errorHandler = vi.fn();
      client.onError(errorHandler);

      // Simulate validation error
      onmessage?.({
        data: JSON.stringify({ kind: "error", error: "invalid message format" }),
      });

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const error = errorHandler.mock.calls[0][0] as PubSubError;
      expect(error.code).toBe("validation");
    });
  });

  describe("connected", () => {
    it("returns true when WebSocket is open", () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        OPEN: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      expect(client.connected).toBe(true);
    });

    it("returns false when WebSocket is not open", () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 0,
        OPEN: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      expect(client.connected).toBe(false);
    });
  });

  describe("reconnection", () => {
    it("attempts reconnection when reconnect option is enabled", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100, maxDelayMs: 1000 },
      });

      expect(wsInstances.length).toBe(1);

      // Simulate disconnect
      wsInstances[0].onclose?.();

      expect(client.reconnecting).toBe(true);

      // Advance timer to trigger reconnect
      await vi.advanceTimersByTimeAsync(100);

      expect(wsInstances.length).toBe(2);
      vi.useRealTimers();
    });

    it("uses exponential backoff for reconnection attempts", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 0, // Stays closed to force reconnection attempts
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100, maxDelayMs: 1000 },
      });

      // First disconnect
      wsInstances[0].onclose?.();

      // First reconnect after 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(2);

      // Second disconnect
      wsInstances[1].onclose?.();

      // Second reconnect should be 200ms (100 * 2^1)
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(2); // Not yet
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(3);

      vi.useRealTimers();
    });

    it("stops reconnecting after max attempts", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 0,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const errorHandler = vi.fn();
      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100, maxDelayMs: 1000, maxAttempts: 2 },
      });
      client.onError(errorHandler);

      // First disconnect -> attempt 1
      wsInstances[0].onclose?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(wsInstances.length).toBe(2);

      // Second disconnect -> attempt 2
      wsInstances[1].onclose?.();
      await vi.advanceTimersByTimeAsync(200);
      expect(wsInstances.length).toBe(3);

      // Third disconnect -> exceeds max, should error
      wsInstances[2].onclose?.();

      expect(errorHandler).toHaveBeenCalledTimes(1);
      const error = errorHandler.mock.calls[0][0] as PubSubError;
      expect(error.message).toBe("max reconnection attempts exceeded");
      expect(client.reconnecting).toBe(false);

      vi.useRealTimers();
    });

    it("calls onDisconnect and onReconnect handlers", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const disconnectHandler = vi.fn();
      const reconnectHandler = vi.fn();

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100 },
      });
      client.onDisconnect(disconnectHandler);
      client.onReconnect(reconnectHandler);

      // Disconnect
      wsInstances[0].onclose?.();
      expect(disconnectHandler).toHaveBeenCalledTimes(1);

      // Reconnect
      await vi.advanceTimersByTimeAsync(100);
      wsInstances[1].onopen?.();

      expect(reconnectHandler).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("uses lastSeenId for reconnection", async () => {
      vi.useFakeTimers();
      const capturedUrls: string[] = [];
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation((url: string) => {
        capturedUrls.push(url);
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100 },
      });

      // Receive a message with ID
      wsInstances[0].onmessage?.({
        data: JSON.stringify({
          kind: "persisted",
          id: 42,
          type: "test",
          payload: {},
          senderId: "other",
          ts: Date.now(),
        }),
      });

      // Disconnect and reconnect
      wsInstances[0].onclose?.();
      await vi.advanceTimersByTimeAsync(100);

      // Check reconnection URL includes lastSeenId
      expect(capturedUrls.length).toBe(2);
      const reconnectUrl = new URL(capturedUrls[1]);
      expect(reconnectUrl.searchParams.get("sinceId")).toBe("42");

      vi.useRealTimers();
    });

    it("allows unsubscribing from handlers", () => {
      MockWebSocket.mockImplementation(() => ({
        readyState: 1,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      }));

      const errorHandler = vi.fn();
      const disconnectHandler = vi.fn();
      const reconnectHandler = vi.fn();

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
      });

      const unsubError = client.onError(errorHandler);
      const unsubDisconnect = client.onDisconnect(disconnectHandler);
      const unsubReconnect = client.onReconnect(reconnectHandler);

      // Unsubscribe all
      unsubError();
      unsubDisconnect();
      unsubReconnect();

      // Verify they return functions (type check)
      expect(typeof unsubError).toBe("function");
      expect(typeof unsubDisconnect).toBe("function");
      expect(typeof unsubReconnect).toBe("function");
    });

    it("does not reconnect when close() is called explicitly", async () => {
      vi.useFakeTimers();
      const wsInstances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        onclose: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
      }> = [];

      MockWebSocket.mockImplementation(() => {
        const ws = {
          readyState: 1,
          onopen: null as (() => void) | null,
          onmessage: null as ((event: { data: string }) => void) | null,
          onerror: null as (() => void) | null,
          onclose: null as (() => void) | null,
          close: vi.fn(() => {
            // Simulate close event
            setTimeout(() => ws.onclose?.(), 0);
          }),
          send: vi.fn(),
        };
        wsInstances.push(ws);
        return ws;
      });

      const client = connect(`ws://127.0.0.1:${port}`, "token", {
        channel: "test",
        reconnect: { delayMs: 100 },
      });

      // Catch the ready promise rejection (expected since we're closing)
      client.ready().catch(() => {
        // Expected rejection - ignore
      });

      // Explicitly close
      client.close();
      await vi.advanceTimersByTimeAsync(0); // Process close event

      expect(client.reconnecting).toBe(false);

      // Wait for potential reconnect
      await vi.advanceTimersByTimeAsync(200);

      // Should not have created a new connection
      expect(wsInstances.length).toBe(1);

      vi.useRealTimers();
    });
  });
});
