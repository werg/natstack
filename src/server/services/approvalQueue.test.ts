import { describe, expect, it, vi } from "vitest";
import { createApprovalQueue, type UnitBatchApprovalQueueRequest } from "./approvalQueue.js";

function createQueue() {
  const emit = vi.fn();
  const queue = createApprovalQueue({ eventService: { emit } as never });
  return { queue, emit };
}

function unitBatchRequest(
  overrides: Partial<UnitBatchApprovalQueueRequest> = {}
): UnitBatchApprovalQueueRequest {
  return {
    kind: "unit-batch" as const,
    callerId: "panel-1",
    callerKind: "panel" as const,
    repoPath: "panels/example",
    effectiveVersion: "hash-1",
    trigger: "source-change" as const,
    title: "Update trusted unit source",
    description: "Accepting this push updates trusted native extension code.",
    units: [
      {
        unitKind: "extension" as const,
        unitName: "@workspace-extensions/typecheck-service",
        displayName: "Typecheck Service",
        version: "1.0.0",
        target: null,
        source: {
          kind: "workspace-repo" as const,
          repo: "extensions/typecheck-service",
          ref: "main",
        },
        ev: "ev-typecheck",
        capabilities: ["node:fs"],
      },
    ],
    configWrite: null,
    ...overrides,
  };
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
      callerId: "panel-1",
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

  it("auto-approves decision prompts without surfacing pending UI", async () => {
    const emit = vi.fn();
    const queue = createApprovalQueue({
      eventService: { emit } as never,
      autoApprove: true,
    });

    await expect(
      queue.request({
        kind: "capability",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/example",
        effectiveVersion: "hash-1",
        capability: "external-browser-open",
        title: "Open external browser",
      })
    ).resolves.toBe("once");

    expect(queue.listPending()).toEqual([]);
    expect(emit).not.toHaveBeenCalledWith("shell-approval:pending-changed", expect.anything());
  });

  it("preserves severe capability approval tone in pending state", async () => {
    const { queue } = createQueue();
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "panel.automate",
      severity: "severe",
      title: "Drive privileged panel",
      resource: {
        type: "panel",
        label: "Panel",
        value: "Shell",
      },
    });

    expect(queue.listPending()[0]).toMatchObject({
      kind: "capability",
      capability: "panel.automate",
      severity: "severe",
      title: "Drive privileged panel",
    });
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("fans out pending changes to listeners and supports unsubscribe", async () => {
    const { queue } = createQueue();
    const listener = vi.fn();
    const unsubscribe = queue.onPendingChanged(listener);
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toHaveLength(1);

    unsubscribe();
    queue.resolve(queue.listPending()[0]!.approvalId, "deny");

    await expect(promise).resolves.toBe("deny");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("treats double resolve as a no-op after the first settlement", async () => {
    const { queue, emit } = createQueue();
    const promise = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });
    const approvalId = queue.listPending()[0]!.approvalId;

    queue.resolve(approvalId, "once");
    queue.resolve(approvalId, "deny");

    await expect(promise).resolves.toBe("once");
    expect(queue.listPending()).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("can isolate one-shot capability approvals from concurrent waiters", async () => {
    const { queue } = createQueue();
    const first = queue.request({
      kind: "capability",
      dedupKey: null,
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "workspace-repo-write",
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
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "workspace-repo-write",
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

  it("does not deduplicate capability approvals across concrete callers", async () => {
    const { queue } = createQueue();
    const first = queue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
      resource: { type: "url-origin", label: "Origin", value: "https://example.com" },
    });
    const second = queue.request({
      kind: "capability",
      callerId: "panel-2",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
      resource: { type: "url-origin", label: "Origin", value: "https://example.com" },
    });

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "session");
    queue.resolve(pending[1]!.approvalId, "deny");
    await expect(first).resolves.toBe("session");
    await expect(second).resolves.toBe("deny");
  });

  it("honors custom unit-batch approval dedup keys", async () => {
    const { queue } = createQueue();
    const first = queue.request(
      unitBatchRequest({ dedupKey: "unit-source-change:extension:typecheck:main" })
    );
    const second = queue.request(
      unitBatchRequest({
        dedupKey: "unit-source-change:extension:typecheck:main",
        effectiveVersion: "newer-commit",
      })
    );

    const pending = queue.listPending();
    expect(pending).toHaveLength(1);

    queue.resolve(pending[0]!.approvalId, "session");
    await expect(first).resolves.toBe("session");
    await expect(second).resolves.toBe("session");
  });

  it("keeps custom unit-batch approval dedup scoped to the concrete caller", async () => {
    const { queue } = createQueue();
    const first = queue.request(
      unitBatchRequest({
        callerId: "panel-1",
        dedupKey: "unit-source-change:extension:typecheck:main",
      })
    );
    const second = queue.request(
      unitBatchRequest({
        callerId: "panel-2",
        dedupKey: "unit-source-change:extension:typecheck:main",
      })
    );

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "once");
    queue.resolve(pending[1]!.approvalId, "deny");
    await expect(first).resolves.toBe("once");
    await expect(second).resolves.toBe("deny");
  });

  it("does not deduplicate credential approvals across concrete callers", async () => {
    const { queue } = createQueue();
    const request = {
      callerKind: "worker" as const,
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
    };
    const first = queue.request({ ...request, callerId: "worker:one" });
    const second = queue.request({ ...request, callerId: "worker:two" });

    const pending = queue.listPending();
    expect(pending).toHaveLength(2);

    queue.resolve(pending[0]!.approvalId, "session");
    queue.resolve(pending[1]!.approvalId, "deny");
    await expect(first).resolves.toBe("session");
    await expect(second).resolves.toBe("deny");
  });

  it("can resolve pending credential approvals that match a newly stored grant", async () => {
    const { queue } = createQueue();
    const request = {
      callerKind: "worker" as const,
      repoPath: "/repo",
      effectiveVersion: "hash-1",
      credentialId: "cred-1",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" as const }],
      injection: {
        type: "header" as const,
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "user-1" },
      scopes: ["repo"],
      grantResource: {
        bindingId: "binding-1",
        resource: "https://api.github.com/",
        action: "use" as const,
      },
    };
    const first = queue.request({ ...request, callerId: "worker:one" });
    const second = queue.request({ ...request, callerId: "worker:two" });

    const pending = queue.listPending();
    queue.resolve(pending[0]!.approvalId, "version");
    await expect(first).resolves.toBe("version");

    const resolved = queue.resolveMatching(
      (approval) =>
        approval.kind === "credential" &&
        approval.credentialId === "cred-1" &&
        approval.repoPath === "/repo" &&
        approval.effectiveVersion === "hash-1" &&
        approval.grantResource?.bindingId === "binding-1" &&
        approval.grantResource.resource === "https://api.github.com/" &&
        approval.grantResource.action === "use",
      "once"
    );

    expect(resolved).toBe(1);
    await expect(second).resolves.toBe("once");
    expect(queue.listPending()).toEqual([]);
  });

  it("supports client config approvals with submitted field values", async () => {
    const { queue } = createQueue();
    const promise = queue.requestClientConfig({
      kind: "client-config",
      callerId: "panel-1",
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
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      title: "Add GitHub",
      credentialLabel: "GitHub",
      audience: [{ url: "https://api.github.com/", match: "origin" }],
      injection: {
        type: "header",
        name: "authorization",
        valueTemplate: "Bearer {token}",
      },
      accountIdentity: { providerUserId: "github-pat" },
      scopes: ["contents:read"],
      fields: [{ name: "token", label: "Fine-grained PAT", type: "secret", required: true }],
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
      callerId: "panel-1",
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

  describe("unit-batch approvals", () => {
    const batchRequest = (overrides: Record<string, unknown> = {}) => ({
      kind: "unit-batch" as const,
      callerId: "system:extensions",
      callerKind: "system" as const,
      repoPath: "meta",
      effectiveVersion: "",
      trigger: "startup" as const,
      title: "Approve workspace extensions",
      description: "2 extensions need approval.",
      units: [
        {
          unitKind: "extension" as const,
          unitName: "@workspace-extensions/image-service",
          displayName: "Image Service",
          source: {
            kind: "workspace-repo" as const,
            repo: "extensions/image-service",
            ref: "main",
          },
          capabilities: ["node:fs"],
        },
        {
          unitKind: "extension" as const,
          unitName: "@workspace-extensions/file-tools",
          displayName: "File Tools",
          source: {
            kind: "workspace-repo" as const,
            repo: "extensions/file-tools",
            ref: "main",
          },
          capabilities: ["node:fs"],
        },
      ],
      ...overrides,
    });

    it("creates a pending unit-batch approval carrying the unit list", async () => {
      const { queue } = createQueue();
      void queue.request(batchRequest());
      await Promise.resolve();
      const pending = queue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "unit-batch",
        trigger: "startup",
        callerKind: "system",
        units: [
          { unitKind: "extension", unitName: "@workspace-extensions/image-service" },
          { unitKind: "extension", unitName: "@workspace-extensions/file-tools" },
        ],
      });
    });

    it("coalesces duplicate reconciles for the same trigger + set onto one prompt", async () => {
      const { queue } = createQueue();
      void queue.request(batchRequest());
      void queue.request(batchRequest());
      await Promise.resolve();
      expect(queue.listPending()).toHaveLength(1);
    });

    it("resolves all waiters when the batch is approved", async () => {
      const { queue } = createQueue();
      const first = queue.request(batchRequest());
      const second = queue.request(batchRequest());
      await Promise.resolve();
      queue.resolve(queue.listPending()[0]!.approvalId, "once");
      await expect(first).resolves.toBe("once");
      await expect(second).resolves.toBe("once");
    });
  });

  describe("userland approvals", () => {
    const userlandRequest = {
      principal: {
        callerId: "worker:alpha",
        callerKind: "worker" as const,
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      },
      subject: { id: "team-x:foo", label: "Team X foo" },
      title: "Allow foo?",
      promptOptions: "choices" as const,
      options: [
        { value: "allow", label: "Allow", tone: "primary" as const },
        { value: "deny", label: "Deny", tone: "danger" as const },
      ],
    };

    it("deduplicates concurrent prompts for the same issuer and subject", async () => {
      const { queue } = createQueue();
      const first = queue.requestUserland(userlandRequest);
      const second = queue.requestUserland(userlandRequest);

      const pending = queue.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "userland",
        callerId: "worker:alpha",
        subject: { id: "team-x:foo" },
      });

      queue.resolveUserland(pending[0]!.approvalId, "allow");
      await expect(first).resolves.toEqual({ kind: "choice", choice: "allow" });
      await expect(second).resolves.toEqual({ kind: "choice", choice: "allow" });
    });

    it("auto-approves userland prompts using the primary option without surfacing pending UI", async () => {
      const emit = vi.fn();
      const queue = createApprovalQueue({
        eventService: { emit } as never,
        autoApprove: true,
      });

      await expect(queue.requestUserland(userlandRequest)).resolves.toEqual({
        kind: "choice",
        choice: "allow",
      });

      expect(queue.listPending()).toEqual([]);
      expect(emit).not.toHaveBeenCalledWith("shell-approval:pending-changed", expect.anything());
    });

    it("auto-approves userland prompts with the first non-danger option when no primary exists", async () => {
      const emit = vi.fn();
      const queue = createApprovalQueue({
        eventService: { emit } as never,
        autoApprove: true,
      });

      await expect(
        queue.requestUserland({
          ...userlandRequest,
          options: [
            { value: "deny", label: "Deny", tone: "danger" },
            { value: "allow_once", label: "Allow once", tone: "neutral" },
          ],
        })
      ).resolves.toEqual({
        kind: "choice",
        choice: "allow_once",
      });

      expect(queue.listPending()).toEqual([]);
      expect(emit).not.toHaveBeenCalledWith("shell-approval:pending-changed", expect.anything());
    });

    it("keeps different issuers with the same subject separate", () => {
      const { queue } = createQueue();
      void queue.requestUserland(userlandRequest);
      void queue.requestUserland({
        ...userlandRequest,
        principal: {
          ...userlandRequest.principal,
          callerId: "worker:beta",
          repoPath: "workers/beta",
        },
      });

      expect(queue.listPending()).toHaveLength(2);
    });

    it("dismisses userland waiters through the generic dismiss path", async () => {
      const { queue } = createQueue();
      const promise = queue.requestUserland(userlandRequest);
      const pending = queue.listPending()[0]!;

      queue.resolve(pending.approvalId, "dismiss");

      await expect(promise).resolves.toEqual({ kind: "dismissed" });
      expect(queue.listPending()).toEqual([]);
    });

    it("rejects resolving a choice the user was not shown", async () => {
      const { queue } = createQueue();
      const promise = queue.requestUserland(userlandRequest);
      const pending = queue.listPending()[0]!;

      expect(() => queue.resolveUserland(pending.approvalId, "maybe")).toThrow(/Unknown userland/);
      expect(queue.listPending()).toHaveLength(1);

      queue.resolve(pending.approvalId, "dismiss");
      await expect(promise).resolves.toEqual({ kind: "dismissed" });
    });

    it("cleans up aborted userland requests", async () => {
      const { queue } = createQueue();
      const ac = new AbortController();
      const promise = queue.requestUserland({ ...userlandRequest, signal: ac.signal });

      ac.abort();

      await expect(promise).resolves.toEqual({ kind: "dismissed" });
      expect(queue.listPending()).toEqual([]);
    });

    it("can resolve pending userland prompts after a scoped grant is recorded", async () => {
      const { queue } = createQueue();
      const first = queue.requestUserland(userlandRequest);
      const second = queue.requestUserland({
        ...userlandRequest,
        principal: {
          ...userlandRequest.principal,
          callerId: "worker:beta",
        },
      });
      const pending = queue.listPending();
      expect(pending).toHaveLength(2);

      queue.resolveUserland(pending[0]!.approvalId, "allow");
      await expect(first).resolves.toEqual({ kind: "choice", choice: "allow" });

      const resolved = queue.resolveMatchingUserland(
        (approval) => approval.kind === "userland" && approval.subject.id === "team-x:foo",
        "allow"
      );

      expect(resolved).toBe(1);
      await expect(second).resolves.toEqual({ kind: "choice", choice: "allow" });
      expect(queue.listPending()).toEqual([]);
    });
  });

  describe("device-code approvals", () => {
    function makeDeviceCodeReq() {
      return {
        kind: "device-code" as const,
        callerId: "panel-test",
        callerKind: "panel" as const,
        repoPath: "panel-test",
        effectiveVersion: "v1",
        credentialLabel: "GitHub CLI",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: undefined,
        expiresAt: Date.now() + 60_000,
        oauthTokenOrigin: "https://github.com",
      };
    }

    it("surfaces the user_code in the pending approvals list", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      const pending = queue.listPending();
      expect(pending).toHaveLength(1);
      const entry = pending[0]!;
      expect(entry.kind).toBe("device-code");
      if (entry.kind === "device-code") {
        expect(entry.userCode).toBe("ABCD-EFGH");
        expect(entry.verificationUri).toBe("https://github.com/login/device");
        expect(entry.credentialLabel).toBe("GitHub CLI");
      }
      expect(handle.cancelled.aborted).toBe(false);
      handle.dispose();
      expect(queue.listPending()).toEqual([]);
    });

    it("fires the cancellation signal when the user dismisses the entry", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      const fired = vi.fn();
      handle.cancelled.addEventListener("abort", fired);
      queue.resolve(handle.approvalId, "dismiss");
      expect(fired).toHaveBeenCalled();
      expect(handle.cancelled.aborted).toBe(true);
      expect(queue.listPending()).toEqual([]);
    });

    it("dispose() removes the entry without firing cancellation", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      const fired = vi.fn();
      handle.cancelled.addEventListener("abort", fired);
      handle.dispose();
      expect(fired).not.toHaveBeenCalled();
      expect(handle.cancelled.aborted).toBe(false);
      expect(queue.listPending()).toEqual([]);
    });

    it("dispose() is idempotent", () => {
      const { queue } = createQueue();
      const handle = queue.presentDeviceCode(makeDeviceCodeReq());
      handle.dispose();
      handle.dispose();
      expect(queue.listPending()).toEqual([]);
    });

    it("each presented device-code is independent (no dedup)", () => {
      const { queue } = createQueue();
      const h1 = queue.presentDeviceCode(makeDeviceCodeReq());
      const h2 = queue.presentDeviceCode(makeDeviceCodeReq());
      expect(queue.listPending()).toHaveLength(2);
      expect(h1.approvalId).not.toBe(h2.approvalId);
    });
  });
});
