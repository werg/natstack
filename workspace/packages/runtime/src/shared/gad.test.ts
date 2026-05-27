import { describe, expect, it, vi } from "vitest";
import { createGadClient } from "./gad.js";

describe("createGadClient", () => {
  it("normalizes object-form rawSql and query calls to the GAD service positional API", async () => {
    const rpc = {
      call: vi.fn(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "workers/gad-store",
            className: "GadWorkspaceDO",
            objectKey: "workspace-gad",
            targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
          };
        }
        return { rows: [] };
      }),
      streamCall: vi.fn(),
    };
    const gad = createGadClient(rpc as never);

    await gad.rawSql({
      sql: "SELECT name FROM sqlite_master WHERE type = ?",
      params: ["table"],
    });
    await gad.query({
      sql: "SELECT * FROM trajectory_events WHERE branch_id = ?",
      bindings: ["branch-1"],
    });

    expect(rpc.call).toHaveBeenNthCalledWith(
      1,
      "main",
      "workers.resolveService",
      ["natstack.gad.workspace.v1", null]
    );
    expect(rpc.call).toHaveBeenNthCalledWith(
      2,
      "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
      "rawSql",
      ["SELECT name FROM sqlite_master WHERE type = ?", ["table"]]
    );
    expect(rpc.call).toHaveBeenNthCalledWith(
      3,
      "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
      "query",
      ["SELECT * FROM trajectory_events WHERE branch_id = ?", ["branch-1"]]
    );
  });

  it("keeps semantic envelope reads hydrated while inspection stays compact", async () => {
    const ref = {
      protocol: "natstack.blob-ref.v1",
      digest: "digest-1",
      size: 15,
      encoding: "json",
      originalBytes: 15,
    };
    const rpc = {
      call: vi.fn(async (target: string, method: string) => {
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "workers/gad-store",
            className: "GadWorkspaceDO",
            objectKey: "workspace-gad",
            targetId: "do:workers/gad-store:GadWorkspaceDO:workspace-gad",
          };
        }
        if (target === "main" && method === "blobstore.getText") {
          return JSON.stringify({ hydrated: true });
        }
        if (method === "listChannelEnvelopes") {
          return [{
            envelopeId: "env-1",
            channelId: "channel-1",
            seq: 1,
            from: { kind: "panel", id: "panel:user" },
            payloadKind: "custom.kind",
            payload: ref,
            publishedAt: "2026-05-20T12:00:00.000Z",
          }];
        }
        if (method === "inspectChannelEnvelopes") {
          return { rows: [{ envelopeId: "env-1", payloadSummary: ref }] };
        }
        return { rows: [] };
      }),
      streamCall: vi.fn(),
    };
    const gad = createGadClient(rpc as never);

    await expect(gad.listChannelEnvelopes({ channelId: "channel-1" })).resolves.toMatchObject([
      { payload: { hydrated: true } },
    ]);
    await expect(gad.inspectChannelEnvelopes({ channelId: "channel-1" })).resolves.toEqual({
      rows: [{ envelopeId: "env-1", payloadSummary: ref }],
    });
  });
});
