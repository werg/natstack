import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("DurableObjectBase panelTree handles", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("routes bare handle RPC events through the refreshed runtime entity id", async () => {
    const calls: Array<{ type?: string; targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        type?: string;
        targetId: string;
        method?: string;
        args?: unknown[];
        event?: string;
        payload?: unknown;
      };
      calls.push({
        type: body.type,
        targetId: body.targetId,
        method: body.method ?? body.event ?? "",
        args: body.args ?? [body.payload],
      });
      if (body.method === "panelTree.metadata") {
        return new Response(
          JSON.stringify({
            result: {
              id: "slot-a",
              title: "Panel A",
              source: "panels/a",
              kind: "workspace",
              parentId: "root",
              runtimeEntityId: "panel:slot-a-current-entity",
            },
          })
        );
      }
      return new Response(JSON.stringify({ result: "ok" }));
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      async probePanelTree(): Promise<{
        title: string | undefined;
        source: string | undefined;
        kind: "workspace" | "browser";
        parentId: string | null;
      }> {
        const handle = this.panelTree.get("slot-a");
        await handle.refresh();
        await handle.call["ping"]?.();
        await handle.emit("ready", { ok: true });
        return {
          title: handle.title,
          source: handle.source,
          kind: handle.kind,
          parentId: handle.parentId,
        };
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toEqual({
      title: "Panel A",
      source: "panels/a",
      kind: "workspace",
      parentId: "root",
    });

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.metadata",
        args: ["slot-a"],
      },
      {
        type: "call",
        targetId: "panel:slot-a-current-entity",
        method: "ping",
        args: [],
      },
      {
        type: "emit",
        targetId: "panel:slot-a-current-entity",
        method: "ready",
        args: [{ ok: true }],
      },
    ]);
  });

  it("resolves isLoaded from the server runtime lease", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targetId: string;
        method: string;
        args: unknown[];
      };
      // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.getRuntimeLease") {
        return new Response(JSON.stringify({ result: { leased: true } }));
      }
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      async probePanelTree(): Promise<boolean> {
        return this.panelTree.get("slot-a").isLoaded();
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toBe(true);

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.getRuntimeLease",
        args: ["slot-a"],
      },
    ]);
  });

  it("lists, hydrates children, and opens panels through the server panelTree service", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targetId: string;
        method: string;
        args: unknown[];
      };
      // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.list" && body.args[0] === null) {
        return new Response(
          JSON.stringify({
            result: [
              {
                panelId: "root-slot",
                title: "Root",
                source: "panels/root",
                kind: "workspace",
                parentId: null,
                contextId: "ctx-root",
                runtimeEntityId: "panel:root-entity",
                children: [
                  {
                    panelId: "child-slot",
                    title: "Child",
                    source: "panels/child",
                    kind: "workspace",
                    parentId: "root-slot",
                    contextId: "ctx-child",
                    runtimeEntityId: "panel:child-entity",
                  },
                ],
              },
            ],
          })
        );
      }
      if (body.method === "panelTree.list" && body.args[0] === "root-slot") {
        return new Response(
          JSON.stringify({
            result: [
              {
                panelId: "child-slot",
                title: "Child",
                source: "panels/child",
                kind: "workspace",
                parentId: "root-slot",
                contextId: "ctx-child",
                runtimeEntityId: "panel:child-entity",
              },
            ],
          })
        );
      }
      if (body.method === "panelTree.create") {
        return new Response(
          JSON.stringify({
            result: {
              id: "created-slot",
              title: "Created",
              kind: "workspace",
              runtimeEntityId: "panel:created-entity",
            },
          })
        );
      }
      return new Response(JSON.stringify({ result: "ok" }));
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class PanelTreeProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      async probePanelTree(): Promise<{
        allIds: string[];
        childParentId: string | null | undefined;
        createdId: string;
        createdParentId: string | null;
      }> {
        const all = await this.panelTree.list();
        const children = await this.panelTree.children("root-slot");
        const created = await this.panelTree.open("panels/new");
        return {
          allIds: all.map((handle) => handle.id),
          childParentId: children[0]?.parent()?.id,
          createdId: created.id,
          createdParentId: created.parentId,
        };
      }
    }

    const { call } = await createTestDO(PanelTreeProbeDO, {
      GATEWAY_URL: "http://server.test",
    });

    await expect(call("probePanelTree")).resolves.toEqual({
      allIds: ["root-slot", "child-slot"],
      childParentId: "root-slot",
      createdId: "created-slot",
      createdParentId: null,
    });

    expect(calls).toEqual([
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: [null],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.list",
        args: ["root-slot"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.create",
        args: ["panels/new", { parentId: null }],
      },
    ]);
  });

  it("builds a panel parent handle with slot-scoped CDP and entity-scoped RPC", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targetId: string;
        method: string;
        args: unknown[];
      };
      // Strip the opaque transport requestId/idempotencyKey; these tests assert routing.
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      return new Response(JSON.stringify({ result: { wsEndpoint: "ws://cdp.test" } }));
    }) as typeof fetch;

    const [{ DurableObjectBase }, { createTestDO }] = await Promise.all([
      import("./durable-base.js"),
      import("./durable-test-utils.js"),
    ]);

    class ParentProbeDO extends DurableObjectBase {
      protected createTables(): void {}

      async probeParent(): Promise<{ id: string; title: string | undefined } | null> {
        const parent = this.getParent();
        if (!parent) return null;
        const info = await parent.getInfo();
        await parent.call["ping"]?.();
        await parent.cdp.getCdpEndpoint();
        await parent.reload();
        await parent.rebuildAndReload();
        return { id: info.id, title: info.title };
      }
    }

    const { instance } = await createTestDO(ParentProbeDO, {
      GATEWAY_URL: "http://server.test",
    });
    const fetchable = instance as unknown as { fetch(request: Request): Promise<Response> };
    const response = await fetchable.fetch(
      new Request("http://test/test-key/probeParent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Natstack-Rpc-Caller-Id": "panel:parent-entity",
          "X-Natstack-Rpc-Caller-Kind": "panel",
          "X-Natstack-Rpc-Caller-Panel-Id": "parent-slot",
        },
        body: JSON.stringify([]),
      })
    );

    await expect(response.json()).resolves.toEqual({ id: "parent-slot", title: "parent-slot" });
    expect(calls).toEqual([
      {
        type: "call",
        targetId: "panel:parent-entity",
        method: "ping",
        args: [],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelCdp.getCdpEndpoint",
        args: ["parent-slot"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.reload",
        args: ["parent-slot"],
      },
      {
        type: "call",
        targetId: "main",
        method: "panelTree.rebuildAndReload",
        args: ["parent-slot"],
      },
    ]);
  });
});
