import { describe, expect, it } from "vitest";
import { createUserlandApprovalAccessPolicy } from "./approvals.js";
import type { RpcCaller } from "@natstack/rpc";
import type { UserlandApprovalRequest } from "@natstack/shared/approvals";

describe("createUserlandApprovalAccessPolicy", () => {
  it("requests approval scoped to the RPC source id", async () => {
    const calls: unknown[][] = [];
    const rpc = {
      async call<T>(...args: unknown[]): Promise<T> {
        calls.push(args);
        return { kind: "choice", choice: "allow" } as T;
      },
    } satisfies RpcCaller;

    const policy = createUserlandApprovalAccessPolicy(rpc, {
      subjectId: "dangerous.write",
      subjectLabel: (ctx) => `Write access for ${ctx.sourceId}`,
      title: (ctx) => `Allow ${ctx.sourceId} to write?`,
      summary: "This method changes stored data.",
      details: [{ label: "Resource", value: "Notes" }],
    });

    await expect(policy({ sourceId: "panel:abc/def" })).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("main");
    expect(calls[0]![1]).toBe("userlandApproval.request");
    const request = calls[0]![2] as UserlandApprovalRequest;
    expect(request.subject.id).toMatch(/^dangerous.write:source:panel:abc\/def:/);
    expect(request.subject.label).toBe("Write access for panel:abc/def");
    expect(request.title).toBe("Allow panel:abc/def to write?");
    expect(request.details).toEqual([
      { label: "Caller", value: "panel:abc/def" },
      { label: "Resource", value: "Notes" },
    ]);
    expect(request.options).toEqual([
      { value: "allow", label: "Allow", tone: "primary" },
      { value: "deny", label: "Deny", tone: "danger" },
    ]);
  });

  it("denies dismissed or deny choices", async () => {
    const responses = [{ kind: "choice", choice: "deny" }, { kind: "dismissed" }];
    const rpc = {
      async call<T>(): Promise<T> {
        return responses.shift() as T;
      },
    } satisfies RpcCaller;
    const policy = createUserlandApprovalAccessPolicy(rpc, {
      subjectId: "action",
      title: "Allow action?",
    });

    await expect(policy({ sourceId: "panel-a" })).resolves.toBe(false);
    await expect(policy({ sourceId: "panel-a" })).resolves.toBe(false);
  });
});
