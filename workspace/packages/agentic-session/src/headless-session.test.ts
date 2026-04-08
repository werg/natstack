import { describe, it, expect } from "vitest";
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
});
