import { describe, expect, it, vi } from "vitest";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@natstack/rpc";
import {
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
  const lookup = vi.fn<(callerId: string, subjectId: string) => UserlandApprovalGrant | null>(
    () => null
  );
  const record = vi.fn(async () => {});
  const revoke = vi.fn(async () => true);
  const list = vi.fn<(callerId: string) => UserlandApprovalGrant[]>(() => []);
  const resolveByCallerId = vi.fn(
    (
      callerId: string
    ): {
      callerId: string;
      callerKind: "panel" | "worker";
      repoPath: string;
      effectiveVersion: string;
    } | null => ({
      callerId,
      callerKind: callerId.startsWith("panel:") ? ("panel" as const) : ("worker" as const),
      repoPath: "workers/alpha",
      effectiveVersion: "hash-1",
    })
  );
  const service = createUserlandApprovalService({
    approvalQueue: { requestUserland: queued } as Partial<ApprovalQueue> as ApprovalQueue,
    grantStore: { lookup, record, revoke, list },
    codeIdentityResolver: { resolveByCallerId },
  });
  return { service, queued, lookup, record, revoke, list, resolveByCallerId };
}

const workerCtx: ServiceContext = { callerId: "worker:alpha", callerKind: "worker" };
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

  it("allows panels and workers but rejects shell/server through policy", async () => {
    const { service } = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service);
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(workerCtx, "userlandApproval", "list", [])).resolves.toEqual(
      []
    );
    await expect(
      dispatcher.dispatch(
        { callerId: "shell", callerKind: "shell" },
        "userlandApproval",
        "list",
        []
      )
    ).rejects.toBeInstanceOf(ServiceAccessError);
  });

  it("rejects unknown caller identities", async () => {
    const { service, resolveByCallerId } = createDeps();
    resolveByCallerId.mockReturnValueOnce(null);

    await expect(service.handler(workerCtx, "request", [validRequest])).rejects.toMatchObject({
      name: "ServiceError",
      code: "ENOENT",
    });
  });

  it("rejects caller kind mismatches with a typed error", async () => {
    const { service, resolveByCallerId } = createDeps();
    resolveByCallerId.mockReturnValueOnce({
      callerId: "worker:alpha",
      callerKind: "panel",
      repoPath: "workers/alpha",
      effectiveVersion: "hash-1",
    });

    await expect(service.handler(workerCtx, "request", [validRequest])).rejects.toMatchObject({
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
    expect(revoke).toHaveBeenCalledWith("worker:alpha", "team-x:foo");
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
      "allow"
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
    expect(revoke).toHaveBeenCalledWith("worker:alpha", "team-x:foo");
    await expect(service.handler(workerCtx, "list", [])).resolves.toHaveLength(1);
    expect(list).toHaveBeenCalledWith("worker:alpha");
  });

  it("throws ServiceError for unknown methods", async () => {
    const { service } = createDeps();

    await expect(service.handler(workerCtx, "missing", [])).rejects.toBeInstanceOf(ServiceError);
    await expect(service.handler(workerCtx, "missing", [])).rejects.toMatchObject({
      code: "ENOSYS",
    });
  });
});
