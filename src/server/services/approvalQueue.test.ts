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
    queue.resolve(queue.listPending()[0]!.approvalId, "once");
    await expect(promise).resolves.toBe("once");
  });

  it("can isolate one-shot capability approvals from concurrent waiters", async () => {
    const { queue } = createQueue();
    const first = queue.request({
      kind: "capability",
      dedupKey: null,
      callerId: "panel:1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "internal-git-write",
      title: "Write project files",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: "panels/target",
      },
    });
    const second = queue.request({
      kind: "capability",
      dedupKey: null,
      callerId: "panel:1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "internal-git-write",
      title: "Write project files",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: "panels/target",
      },
    });

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "once");
    await expect(first).resolves.toBe("once");
    expect(queue.listPending()).toHaveLength(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(second).resolves.toBe("deny");
  });

  it("supports client config approvals with submitted field values", async () => {
    const { queue } = createQueue();
    const promise = queue.requestClientConfig({
      kind: "client-config",
      callerId: "panel:1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      configId: "google-workspace",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      title: "Configure Google Workspace OAuth",
      fields: [
        { name: "clientId", label: "Client ID", type: "text", required: true },
        { name: "clientSecret", label: "Client secret", type: "secret", required: true },
      ],
    });

    const pending = queue.listPending()[0]!;
    expect(pending).toMatchObject({
      kind: "client-config",
      configId: "google-workspace",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: [
        { name: "clientId", type: "text" },
        { name: "clientSecret", type: "secret" },
      ],
    });
    expect(JSON.stringify(pending)).not.toContain("secret-1");

    queue.submitClientConfig(pending.approvalId, {
      clientId: "client-1",
      clientSecret: "secret-1",
    });

    await expect(promise).resolves.toEqual({
      decision: "submit",
      values: {
        clientId: "client-1",
        clientSecret: "secret-1",
      },
    });
  });

  it("supports credential input approvals without exposing submitted secrets in pending state", async () => {
    const { queue } = createQueue();
    const promise = queue.requestCredentialInput({
      kind: "credential-input",
      callerId: "panel:1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      title: "Add GitHub",
      credentialLabel: "GitHub",
      audience: [
        { url: "https://api.github.com/", match: "origin" },
      ],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "github-pat" },
      scopes: ["contents:read"],
      fields: [
        { name: "token", label: "Fine-grained PAT", type: "secret", required: true },
      ],
    });

    const pending = queue.listPending()[0]!;
    expect(pending).toMatchObject({
      kind: "credential-input",
      credentialLabel: "GitHub",
      fields: [{ name: "token", type: "secret" }],
    });
    expect(JSON.stringify(pending)).not.toContain("github_pat_1");

    queue.submitCredentialInput(pending.approvalId, {
      token: "github_pat_1",
    });

    await expect(promise).resolves.toEqual({
      decision: "submit",
      values: {
        token: "github_pat_1",
      },
    });
  });

  it("does not deduplicate credential input approvals", async () => {
    const { queue } = createQueue();
    const request = {
      kind: "credential-input" as const,
      callerId: "panel:1",
      callerKind: "panel" as const,
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      title: "Add GitHub",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "github-pat" },
      scopes: ["contents:read"],
      fields: [
        { name: "token", label: "Fine-grained PAT", type: "secret" as const, required: true },
      ],
    };
    const first = queue.requestCredentialInput(request);
    const second = queue.requestCredentialInput(request);

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.submitCredentialInput(pending[0]!.approvalId, { token: "github_pat_1" });
    await expect(first).resolves.toEqual({
      decision: "submit",
      values: { token: "github_pat_1" },
    });
    expect(queue.listPending()).toHaveLength(1);

    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(second).resolves.toEqual({ decision: "deny" });
  });
});
