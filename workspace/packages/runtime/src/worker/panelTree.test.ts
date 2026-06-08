import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("worker panelTree handles", () => {
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
        method: string;
        args: unknown[];
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

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    const handle = runtime.panelTree.get("slot-a");
    await handle.refresh();
    expect(handle.title).toBe("Panel A");
    expect(handle.source).toBe("panels/a");
    expect(handle.kind).toBe("workspace");
    expect(handle.parentId).toBe("root");
    await handle.call["ping"]?.();
    await handle.emit("ready", { ok: true });
    runtime.destroy();

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
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      if (body.method === "panelTree.getRuntimeLease") {
        return new Response(JSON.stringify({ result: { leased: true } }));
      }
      return new Response(JSON.stringify({ result: null }));
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
    });

    await expect(runtime.panelTree.get("slot-a").isLoaded()).resolves.toBe(true);
    runtime.destroy();

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

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "parent-slot",
      PARENT_KIND: "panel",
    });

    const all = await runtime.panelTree.list();
    const children = await runtime.panelTree.children("root-slot");
    const created = await runtime.panelTree.open("panels/new");
    runtime.destroy();

    expect(all.map((handle) => handle.id)).toEqual(["root-slot", "child-slot"]);
    expect(children.map((handle) => handle.id)).toEqual(["child-slot"]);
    expect(children[0]?.parent()?.id).toBe("root-slot");
    expect(created.id).toBe("created-slot");
    expect(created.parentId).toBe("parent-slot");
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
        args: ["panels/new", { parentId: "parent-slot" }],
      },
    ]);
  });

  it("builds panel parent handles with slot-scoped CDP/control and entity-scoped RPC", async () => {
    const calls: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        targetId: string;
        method: string;
        args: unknown[];
      };
      delete (body as Record<string, unknown>)["requestId"];
      delete (body as Record<string, unknown>)["idempotencyKey"];
      calls.push(body);
      return new Response(JSON.stringify({ result: { wsEndpoint: "ws://cdp.test" } }));
    }) as typeof fetch;

    const { createWorkerRuntime } = await import("./index.js");
    const runtime = createWorkerRuntime({
      WORKER_ID: "agent",
      RPC_AUTH_TOKEN: "token",
      CONTEXT_ID: "ctx",
      GATEWAY_URL: "http://server.test",
      PARENT_ID: "parent-slot",
      PARENT_ENTITY_ID: "panel:parent-entity",
      PARENT_KIND: "panel",
    });

    const parent = runtime.getParent();
    expect(parent?.id).toBe("parent-slot");
    await expect(parent?.getInfo()).resolves.toMatchObject({
      id: "parent-slot",
      parentId: null,
    });
    await parent?.call["ping"]?.();
    await parent?.cdp.getCdpEndpoint();
    await parent?.reload();
    await parent?.rebuildAndReload();
    runtime.destroy();

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
