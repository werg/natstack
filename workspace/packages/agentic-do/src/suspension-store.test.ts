import { describe, it, expect } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import type { SqlStorage } from "@workspace/runtime/worker";
import { SuspensionStore, credentialSuspensionId } from "./suspension-store.js";

async function makeStore(): Promise<SuspensionStore> {
  const sql = (await createInMemorySql()) as unknown as SqlStorage;
  const store = new SuspensionStore(sql, () => 1000);
  store.createTables();
  return store;
}

const ID = credentialSuspensionId("chat-1", "openai");

describe("SuspensionStore", () => {
  it("records and finds a suspension by id and by requestId", async () => {
    const store = await makeStore();
    store.record({
      id: ID,
      requestId: "req-1",
      channelId: "chat-1",
      turnId: "turn-1",
      reason: "credential",
      resumeCount: 3,
      payload: { providerId: "openai", modelBaseUrl: "https://m/v1" },
    });

    expect(store.findById(ID)).toMatchObject({
      id: ID,
      requestId: "req-1",
      turnId: "turn-1",
      status: "suspended",
      resumeCount: 3,
      payload: { providerId: "openai", modelBaseUrl: "https://m/v1" },
    });
    expect(store.findByRequestId("req-1")?.id).toBe(ID);
  });

  it("supports a suspension with no requestId (reconnect/missing parks)", async () => {
    const store = await makeStore();
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential" });
    expect(store.findById(ID)?.requestId).toBeNull();
    expect(store.listRedrivable("credential")).toEqual([]);
    // Resumed by id (the UI credential-connected path), claim still works.
    expect(store.claimResume(ID)).toBe(true);
  });

  it("can stop deferred re-drive while leaving the suspension resumable", async () => {
    const store = await makeStore();
    store.record({
      id: ID,
      requestId: "req-1",
      idempotencyKey: "idem-1",
      channelId: "chat-1",
      turnId: "turn-1",
      reason: "credential",
    });
    expect(store.listRedrivable("credential").map((row) => row.id)).toEqual([ID]);

    store.clearRequestIdIfSuspended(ID);
    expect(store.findByRequestId("req-1")).toBeNull();
    expect(store.listRedrivable("credential")).toEqual([]);
    expect(store.findById(ID)).toMatchObject({
      id: ID,
      requestId: null,
      idempotencyKey: null,
      status: "suspended",
    });
    expect(store.claimResume(ID)).toBe(true);
  });

  it("claimResume is atomic/idempotent — exactly one claim wins", async () => {
    const store = await makeStore();
    store.record({ id: ID, requestId: "req-1", channelId: "chat-1", turnId: "turn-1", reason: "credential" });

    expect(store.claimResume(ID)).toBe(true);
    expect(store.findById(ID)?.status).toBe("resuming");
    // Every subsequent claim loses — kills the double-resume race (P1-1).
    expect(store.claimResume(ID)).toBe(false);
    expect(store.claimResume(ID)).toBe(false);
  });

  it("claimResume returns false for an unknown id", async () => {
    const store = await makeStore();
    expect(store.claimResume("nope")).toBe(false);
  });

  it("releaseClaim re-arms a claimed resume so a later trigger can retry", async () => {
    const store = await makeStore();
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential" });
    expect(store.claimResume(ID)).toBe(true);
    store.releaseClaim(ID);
    expect(store.findById(ID)?.status).toBe("suspended");
    expect(store.claimResume(ID)).toBe(true);
  });

  it("resolve drops the row; a post-resolve claim is a no-op (idempotent delivery)", async () => {
    const store = await makeStore();
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential" });
    store.resolve(ID);
    expect(store.findById(ID)).toBeNull();
    expect(store.claimResume(ID)).toBe(false);
  });

  it("listSuspended returns only suspended rows, hasOpenSuspension tracks the turn", async () => {
    const store = await makeStore();
    const id2 = credentialSuspensionId("chat-1", "anthropic");
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential" });
    store.record({ id: id2, channelId: "chat-1", turnId: "turn-2", reason: "credential" });
    expect(store.listSuspended().map((r) => r.id).sort()).toEqual([id2, ID].sort());
    expect(store.hasOpenSuspension("chat-1", "turn-1")).toBe(true);

    // A claimed (resuming) row is still "open" but no longer "suspended".
    store.claimResume(ID);
    expect(store.listSuspended().map((r) => r.id)).toEqual([id2]);
    expect(store.hasOpenSuspension("chat-1", "turn-1")).toBe(true);

    store.resolve(ID);
    expect(store.hasOpenSuspension("chat-1", "turn-1")).toBe(false);
  });

  it("clearForTurn drops all suspensions for a terminated turn", async () => {
    const store = await makeStore();
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential" });
    store.clearForTurn("chat-1", "turn-1");
    expect(store.findById(ID)).toBeNull();
  });

  it("expireOverdue claims only suspensions past their expiry", async () => {
    const store = await makeStore();
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential", expiresAt: 5000 });
    const id2 = credentialSuspensionId("chat-1", "anthropic");
    store.record({ id: id2, channelId: "chat-1", turnId: "turn-2", reason: "credential", expiresAt: 9000 });
    const id3 = credentialSuspensionId("chat-1", "no-expiry");
    store.record({ id: id3, channelId: "chat-1", turnId: "turn-3", reason: "credential" });

    expect(store.nextExpiry()).toBe(5000);
    const expired = store.expireOverdue(6000);
    expect(expired.map((row) => row.id)).toEqual([ID]);
    // Claimed via the resume transition — a real resume can no longer race it.
    expect(store.claimResume(ID)).toBe(false);
    // Untouched rows remain suspended and resumable.
    expect(store.claimResume(id2)).toBe(true);
    expect(store.nextExpiry()).toBeNull();
    expect(store.findById(id3)?.status).toBe("suspended");
  });

  it("expireOverdue never claims a suspension that already resumed", async () => {
    const store = await makeStore();
    store.record({ id: ID, channelId: "chat-1", turnId: "turn-1", reason: "credential", expiresAt: 5000 });
    expect(store.claimResume(ID)).toBe(true);
    expect(store.expireOverdue(6000)).toEqual([]);
  });
});
