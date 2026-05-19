import { describe, expect, it, vi } from "vitest";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@natstack/rpc";
import {
  createVerifiedCaller,
  ServiceAccessError,
  ServiceDispatcher,
  ServiceError,
} from "@natstack/shared/serviceDispatcher";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createUserlandApprovalService } from "./userlandApprovalService.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { UserlandApprovalGrant } from "@natstack/shared/approvals";

function createDeps() {
  const queued = vi.fn<ApprovalQueue["requestUserland"]>(async () => ({
    kind: "choice",
    choice: "allow",
  }));
  const lookup = vi.fn<
    (callerId: string, subjectId: string, issuer?: unknown) => UserlandApprovalGrant | null
  >(() => null);
  const record = vi.fn(async () => {});
  const revoke = vi.fn(async () => true);
  const list = vi.fn<(callerId: string, issuer?: unknown) => UserlandApprovalGrant[]>(() => []);
  const service = createUserlandApprovalService({
    approvalQueue: { requestUserland: queued } as Partial<ApprovalQueue> as ApprovalQueue,
    grantStore: { lookup, record, revoke, list },
  });
  return { service, queued, lookup, record, revoke, list };
}

const workerCtx: ServiceContext = {
  caller: createVerifiedCaller("worker:alpha", "worker", {
    callerId: "worker:alpha",
    callerKind: "worker",
    repoPath: "workers/alpha",
    effectiveVersion: "hash-1",
  }),
};
const doCtx: ServiceContext = {
  caller: createVerifiedCaller("do:workers/alpha:AlphaDO:agent-1", "do", {
    callerId: "do:workers/alpha:AlphaDO:agent-1",
    callerKind: "do",
    repoPath: "workers/alpha",
    effectiveVersion: "hash-1",
  }),
};
const extensionCtx: ServiceContext = {
  caller: createVerifiedCaller("@workspace-extensions/shell", "extension"),
  chainCaller: {
    callerId: "panel:alpha",
    callerKind: "panel",
    repoPath: "panels/alpha",
    effectiveVersion: "panel-hash",
  },
};
const validRequest = {
  subject: { id: "team-x:foo", label: "Team X foo" },
  title: "Allow foo?",
  summary: "Caller wants foo.",
  options: [
    { value: "allow", label: "Allow", tone: "primary" as const },
    { value: "deny", label: "Deny", tone: "danger" as const },
  ],
};

describe("userlandApprovalService", () => {
  it("is routed to the server by default", () => {
    expect(ELECTRON_LOCAL_SERVICE_NAMES).not.toContain("userlandApproval");
  });

  it("allows panels, workers, DOs, and extensions but rejects shell/server through policy", async () => {
    const { service } = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(workerCtx, "userlandApproval", "list", [])).resolves.toEqual(
      []
    );
    await expect(dispatcher.dispatch(doCtx, "userlandApproval", "list", [])).resolves.toEqual([]);
    await expect(
      dispatcher.dispatch(extensionCtx, "userlandApproval", "list", [])
    ).resolves.toEqual([]);
    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("shell", "shell") },
        "userlandApproval",
        "list",
        []
      )
    ).rejects.toBeInstanceOf(ServiceAccessError);
  });

  it("rejects unknown caller identities", async () => {
    const { service } = createDeps();

    await expect(
      service.handler({ caller: createVerifiedCaller("worker:unknown", "worker") }, "request", [
        validRequest,
      ])
    ).rejects.toMatchObject({
      name: "ServiceError",
      code: "ENOENT",
    });
  });

  it("rejects caller kind mismatches with a typed error", async () => {
    const { service } = createDeps();
    const mismatchCtx: ServiceContext = {
      caller: createVerifiedCaller("worker:alpha", "worker", {
        callerId: "worker:alpha",
        callerKind: "panel",
        repoPath: "workers/alpha",
        effectiveVersion: "hash-1",
      }),
    };

    await expect(service.handler(mismatchCtx, "request", [validRequest])).rejects.toMatchObject({
      name: "ServiceError",
      code: "EACCES",
    });
  });

  it("validates reserved prefixes, zero-width bypasses, and duplicate options after stripping", () => {
    const { service } = createDeps();
    const schema = service.methods["request"]!.args;

    expect(() => schema.parse([{ ...validRequest, subject: { id: "shell:foo" } }])).toThrow(
      /reserved/
    );
    expect(() => schema.parse([{ ...validRequest, subject: { id: "shell\u200B:foo" } }])).toThrow(
      /reserved/
    );
    expect(() => schema.parse([{ ...validRequest, title: "bad\u0001title" }])).toThrow(/control/);
    expect(() =>
      schema.parse([
        {
          ...validRequest,
          options: [
            { value: "allow", label: "Allow" },
            { value: "al\u200Blow", label: "Allow again" },
          ],
        },
      ])
    ).toThrow(/unique/);
  });

  it("short-circuits queue prompts on cache hit", async () => {
    const { service, lookup, queued } = createDeps();
    lookup.mockReturnValueOnce({
      principal: { callerId: "worker:alpha", callerKind: "worker" as const },
      subject: { id: "team-x:foo" },
      choice: "allow",
      grantedAt: 10,
    });

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(queued).not.toHaveBeenCalled();
  });

  it("revokes stale cached choices and prompts when the current options changed", async () => {
    const { service, lookup, revoke, queued } = createDeps();
    lookup.mockReturnValueOnce({
      principal: { callerId: "worker:alpha", callerKind: "worker" as const },
      subject: { id: "team-x:foo" },
      choice: "old-choice",
      grantedAt: 10,
    });
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(revoke).toHaveBeenCalledWith("worker:alpha", "team-x:foo", undefined);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("continues to prompt if stale-grant revocation fails", async () => {
    const { service, lookup, revoke, queued } = createDeps();
    lookup.mockReturnValueOnce({
      principal: { callerId: "worker:alpha", callerKind: "worker" as const },
      subject: { id: "team-x:foo" },
      choice: "old-choice",
      grantedAt: 10,
    });
    revoke.mockRejectedValueOnce(new Error("disk full"));
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("persists choices, skips dismissals, and logs persistence failures without changing the result", async () => {
    const { service, queued, record } = createDeps();

    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(record).toHaveBeenCalledWith(
      { callerId: "worker:alpha", callerKind: "worker" },
      validRequest.subject,
      "allow",
      expect.any(Number),
      undefined
    );

    record.mockClear();
    queued.mockResolvedValueOnce({ kind: "dismissed" });
    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "dismissed",
    });
    expect(record).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });
    record.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    await expect(service.handler(workerCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("revokes and lists only the calling issuer grants", async () => {
    const { service, revoke, list } = createDeps();
    list.mockReturnValueOnce([
      {
        principal: { callerId: "worker:alpha", callerKind: "worker" as const },
        subject: { id: "team-x:foo" },
        choice: "allow",
        grantedAt: 10,
      },
    ]);

    await expect(service.handler(workerCtx, "revoke", ["team-x:foo"])).resolves.toBe(true);
    expect(revoke).toHaveBeenCalledWith("worker:alpha", "team-x:foo", undefined);
    await expect(service.handler(workerCtx, "list", [])).resolves.toHaveLength(1);
    expect(list).toHaveBeenCalledWith("worker:alpha", undefined);
  });

  it("returns uncallable for unattributed extension callers", async () => {
    const { service, queued, list } = createDeps();
    const unattributed: ServiceContext = {
      caller: createVerifiedCaller("@workspace-extensions/shell", "extension"),
    };

    await expect(service.handler(unattributed, "request", [validRequest])).resolves.toEqual({
      kind: "uncallable",
      reason: "no-user-context",
    });
    expect(queued).not.toHaveBeenCalled();
    await expect(service.handler(unattributed, "revoke", ["team-x:foo"])).resolves.toEqual({
      kind: "uncallable",
      reason: "no-user-context",
    });
    await expect(service.handler(unattributed, "list", [])).resolves.toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("scopes extension approvals by chain caller and extension issuer", async () => {
    const { service, lookup, queued, record, revoke, list } = createDeps();
    queued.mockResolvedValueOnce({ kind: "choice", choice: "allow" });

    await expect(service.handler(extensionCtx, "request", [validRequest])).resolves.toEqual({
      kind: "choice",
      choice: "allow",
    });
    const issuer = { kind: "extension", id: "@workspace-extensions/shell" };
    expect(lookup).toHaveBeenCalledWith("panel:alpha", "team-x:foo", issuer);
    expect(queued).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: extensionCtx.chainCaller,
        issuer,
        details: expect.arrayContaining([
          { label: "Extension", value: "@workspace-extensions/shell" },
        ]),
      })
    );
    expect(record).toHaveBeenCalledWith(
      { callerId: "panel:alpha", callerKind: "panel" },
      validRequest.subject,
      "allow",
      expect.any(Number),
      issuer
    );
    await service.handler(extensionCtx, "revoke", ["team-x:foo"]);
    expect(revoke).toHaveBeenCalledWith("panel:alpha", "team-x:foo", issuer);
    await service.handler(extensionCtx, "list", []);
    expect(list).toHaveBeenCalledWith("panel:alpha", issuer);
  });

  it("throws ServiceError for unknown methods", async () => {
    const { service } = createDeps();

    await expect(service.handler(workerCtx, "missing", [])).rejects.toBeInstanceOf(ServiceError);
    await expect(service.handler(workerCtx, "missing", [])).rejects.toMatchObject({
      code: "ENOSYS",
    });
  });
});
