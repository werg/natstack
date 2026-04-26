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
      providerNamespace: "github",
      providerFingerprint: "fingerprint-1",
      providerDisplayName: "GitHub",
      providerAudience: ["https://api.github.com/"],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
        strippedHeaders: ["authorization"],
      },
      connectionId: "conn-1",
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
      signal: ac.signal,
    });

    ac.abort();

    await expect(promise).resolves.toBe("deny");
    expect(queue.listPending()).toEqual([]);
  });

  it("includes provider audience in pending approvals", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      callerId: "worker:1",
      callerKind: "worker",
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      providerNamespace: "github",
      providerFingerprint: "fingerprint-1",
      providerDisplayName: "GitHub",
      providerAudience: ["https://api.github.com/"],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
        strippedHeaders: ["authorization"],
      },
      connectionId: "conn-1",
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
    });

    expect(queue.listPending()[0]).toMatchObject({
      providerDisplayName: "GitHub",
      providerAudience: ["https://api.github.com/"],
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });
});
