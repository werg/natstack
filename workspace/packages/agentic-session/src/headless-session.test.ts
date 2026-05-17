import { describe, it, expect, vi } from "vitest";
import { HeadlessSession } from "./headless-session.js";

describe("HeadlessSession", () => {
  it("constructs without connecting", () => {
    const session = HeadlessSession.create({
      config: {
        serverUrl: "http://test.invalid",
        token: "test-token",
        clientId: "headless-test",
      },
    });

    expect(session.connected).toBe(false);
    expect(session.channelId).toBe(null);
    expect(session.messages).toEqual([]);
    expect(session.methodEntries.size).toBe(0);
  });

  it("snapshot returns initial state for an unconnected session", () => {
    const session = HeadlessSession.create({
      config: {
        serverUrl: "http://test.invalid",
        token: "test-token",
        clientId: "headless-test",
      },
    });

    const snap = session.snapshot();
    expect(snap.connected).toBe(false);
    expect(snap.messages).toEqual([]);
    expect(snap.methodHistory).toEqual([]);
    expect(snap.participants).toEqual({});
  });

  it("dispose is idempotent", () => {
    const session = HeadlessSession.create({
      config: {
        serverUrl: "http://test.invalid",
        token: "test-token",
        clientId: "headless-test",
      },
    });

    expect(() => {
      session.dispose();
      session.dispose();
    }).not.toThrow();
  });

  it("callMethod returns the provider payload and callMethodResult returns the full envelope", async () => {
    const session = HeadlessSession.create({
      config: {
        serverUrl: "http://test.invalid",
        token: "test-token",
        clientId: "headless-test",
      },
    });
    const envelope = {
      content: { ok: true },
      contentType: "application/json",
    };
    (session as any)._client = {
      callMethod: vi.fn(() => ({ result: Promise.resolve(envelope) })),
    };

    await expect(session.callMethod("agent-1", "work", {})).resolves.toEqual({ ok: true });
    await expect(session.callMethodResult("agent-1", "work", {})).resolves.toEqual(envelope);
  });

  it("sandbox callMethod follows the same raw-payload contract", async () => {
    const session = HeadlessSession.create({
      config: {
        serverUrl: "http://test.invalid",
        token: "test-token",
        clientId: "headless-test",
      },
    });
    (session as any)._client = {
      callMethod: vi.fn(() => ({
        result: Promise.resolve({ content: { resumed: true } }),
      })),
    };

    const chat = (session as any).buildChatSandboxValue();

    await expect(chat.callMethod("agent-1", "credentialConnected", {})).resolves.toEqual({ resumed: true });
    await expect(chat.callMethodResult("agent-1", "credentialConnected", {})).resolves.toEqual({
      content: { resumed: true },
    });
  });
});
