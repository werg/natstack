import { describe, it, expect } from "vitest";
import { HeadlessSession } from "./headless-session.js";

describe("HeadlessSession waitForIdle", () => {
  it("resolves on completed method history even without an assistant text message", async () => {
    const session = HeadlessSession.create({
      config: {
        serverUrl: "http://test.invalid",
        token: "test-token",
        clientId: "headless-test",
      },
    });

    const tracker = (session.manager as unknown as {
      _methodHistory: {
        addEntry: (entry: {
          callId: string;
          methodName: string;
          args: unknown;
          status: "pending" | "success" | "error";
          startedAt: number;
        }) => void;
        handleMethodResult: (result: {
          kind: "ephemeral";
          senderId: string;
          ts: number;
          callId: string;
          content: unknown;
          complete: boolean;
          isError: boolean;
        }) => void;
      };
    })._methodHistory;

    const waitPromise = session.waitForIdle({ timeout: 200, debounce: 10 });

    setTimeout(() => {
      tracker.addEntry({
        callId: "call-1",
        methodName: "eval",
        args: { code: "1 + 1" },
        status: "pending",
        startedAt: 1,
      });
      tracker.handleMethodResult({
        kind: "ephemeral",
        senderId: "agent-1",
        ts: 2,
        callId: "call-1",
        content: { ok: true, value: 2 },
        complete: true,
        isError: false,
      });
    }, 0);

    const result = await waitPromise;
    expect(result.kind).toBe("method");
    expect(result.method?.callId).toBe("call-1");
    expect(session.snapshot().methodHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: "call-1",
          method: "eval",
          status: "success",
          result: { ok: true, value: 2 },
        }),
      ])
    );
  });
});
