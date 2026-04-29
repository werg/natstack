import { describe, expect, it, vi } from "vitest";
import { createApprovalQueue } from "./approvalQueue.js";

function createQueue() {
  const emit = vi.fn();
  const queue = createApprovalQueue({ eventService: { emit } as never });
  return { queue, emit };
}

describe("approvalQueue", () => {
  it("settles aborted requests as deny", async () => {
    const { queue } = createQueue();
    const ac = new AbortController();
    const promise = queue.request({
      callerId: "worker:1",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
      signal: ac.signal,
    });

    ac.abort();

    await expect(promise).resolves.toBe("deny");
    expect(queue.listPending()).toEqual([]);
  });

  it("includes credential audience in pending approvals", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      callerId: "worker:1",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "credential",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("supports generic capability approvals", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      kind: "capability",
      callerId: "panel:1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
      resource: {
        type: "url-origin",
        label: "Origin",
        value: "https://example.com",
      },
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "capability",
      title: "Open external browser",
      capability: "external-browser-open",
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "session");
    await expect(promise).resolves.toBe("session");
  });
});
