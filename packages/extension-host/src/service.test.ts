import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ExtensionHost } from "./service.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-host-"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function panelCtx(callerId = "panel-1") {
  return {
    caller: createVerifiedCaller(callerId, "panel", {
      callerId,
      callerKind: "panel",
      repoPath: "panels/test",
      effectiveVersion: "ev-test",
    }),
  };
}

function doCtx(callerId = "do:workers/agent-worker:AiChatWorker:agent-1") {
  return {
    caller: createVerifiedCaller(callerId, "do", {
      callerId,
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-agent",
    }),
  };
}

function makeHost(overrides: {
  approvalDecision?: "once" | "session" | "version" | "repo" | "deny";
  activeEv?: string | null;
  depEv?: string | null;
  activeDepEv?: string | null;
  activeExternalDeps?: Record<string, string>;
  candidateExternalDeps?: Record<string, string>;
  activeRuntimeDepsKey?: string | null;
  extensionTransport?: { call: ReturnType<typeof vi.fn> };
  getContextIdForCaller?: (callerId: string) => string | null;
  installed?: boolean;
  enabled?: boolean;
  status?: "running" | "stopped" | "building" | "error" | "pending-approval";
  activeBundleKey?: string | null;
} = {}) {
  const statePath = tempDir();
  const extensionNode = {
    name: "@workspace-extensions/git-tools",
    kind: "extension",
    relativePath: "extensions/@workspace-extensions/git-tools",
    path: path.join(statePath, "source", "extensions", "@workspace-extensions", "git-tools"),
    dependencies: overrides.candidateExternalDeps ?? {},
    internalDeps: ["@workspace/runtime"],
    manifest: {
      displayName: "Git Tools",
      extension: { activationEvents: ["*"] },
    },
  };
  fs.mkdirSync(extensionNode.path, { recursive: true });
  fs.writeFileSync(
    path.join(extensionNode.path, "package.json"),
    JSON.stringify({
      name: extensionNode.name,
      version: "1.0.0",
      natstack: {
        displayName: "Git Tools",
        extension: { activationEvents: ["*"] },
      },
    }),
  );
  const approvalQueue = {
    request: vi.fn(async () => overrides.approvalDecision ?? "once"),
  };
  const eventService = { emit: vi.fn(), getOrCreateSubscriber: vi.fn(), subscribe: vi.fn() };
  const buildSystem = {
    getBuild: vi.fn(async () => ({
      bundlePath: path.join(statePath, "builds", "candidate-key", "bundle.js"),
      dir: path.join(statePath, "builds", "candidate-key"),
      metadata: {
        ev: "ev-candidate",
        runtimeDepsKey: "runtime-candidate",
        extensionRuntimeAbi: "2",
      },
    })),
    getBuildByKey: vi.fn((key: string) => key === "bundle-key" || key === "candidate-key"
      ? {
          bundlePath: path.join(statePath, "builds", key, "bundle.js"),
          dir: path.join(statePath, "builds", key),
          metadata: {
            ev: key === "candidate-key" ? "ev-candidate" : (overrides.activeEv ?? "ev-current"),
            runtimeDepsKey: key === "candidate-key" ? "runtime-candidate" : "runtime-key",
            extensionRuntimeAbi: "2",
          },
        }
      : null),
    getEffectiveVersion: vi.fn((name: string) => {
      if (name === extensionNode.name) return overrides.activeEv ?? "ev-current";
      if (name === "@workspace/runtime") return overrides.depEv ?? "ev-runtime";
      return null;
    }),
    getExternalDeps: vi.fn((name: string) => {
      if (name === extensionNode.name) return overrides.candidateExternalDeps ?? {};
      return {};
    }),
    getGraph: () => ({ allNodes: () => [extensionNode] }),
    onPushBuild: vi.fn(),
  };
  const host = new ExtensionHost({
    statePath,
    workspacePath: path.join(statePath, "source"),
    workspaceId: "workspace-test",
    buildSystem,
    tokenManager: { ensureToken: vi.fn() } as any,
    eventService: eventService as any,
    approvalQueue,
    getGatewayUrl: () => "http://127.0.0.1:3000",
    getContextIdForCaller: overrides.getContextIdForCaller,
    extensionTransport: overrides.extensionTransport ?? {
      call: vi.fn(async () => {
        throw new Error("extensionTransport.call should not be invoked in this test");
      }),
    },
  });
  if (overrides.installed !== false) {
    host.registry.upsert({
      name: extensionNode.name,
      version: "1.0.0",
      source: { kind: "internal-git", repo: extensionNode.relativePath, ref: "main" },
      installedAt: Date.now(),
      activeEv: overrides.activeEv ?? "ev-current",
      activeSha: "abc123",
      activeBundleKey: overrides.activeBundleKey === undefined ? "bundle-key" : overrides.activeBundleKey,
      activeDependencyEvs: { "@workspace/runtime": overrides.activeDepEv ?? overrides.depEv ?? "ev-runtime" },
      activeExternalDeps: overrides.activeExternalDeps ?? {},
      activeRuntimeDepsKey: overrides.activeRuntimeDepsKey === undefined ? "runtime-key" : overrides.activeRuntimeDepsKey,
      enabled: overrides.enabled ?? true,
      status: overrides.status ?? "running",
      lastError: overrides.status === "error" ? "previous failure" : null,
    });
  }
  return { host, approvalQueue, buildSystem, extensionNode, eventService };
}

describe("ExtensionHost invocation attribution", () => {
  it("passes caller context id through extension invocations", async () => {
    const extensionTransport = {
      call: vi.fn(async () => "ok"),
    };
    const { host } = makeHost({
      extensionTransport,
      getContextIdForCaller: (callerId) => callerId === "panel-1" ? "ctx-panel" : null,
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(host.invoke(panelCtx("panel-1"), "@workspace-extensions/git-tools", "ping", []))
      .resolves.toBe("ok");

    expect(extensionTransport.call).toHaveBeenCalledWith(
      "@workspace-extensions/git-tools",
      "extension.invoke",
      "ping",
      [],
      expect.objectContaining({
        caller: expect.objectContaining({
          callerId: "panel-1",
          contextId: "ctx-panel",
        }),
        chainCaller: expect.objectContaining({
          callerId: "panel-1",
          contextId: "ctx-panel",
        }),
      }),
    );
  });
});

describe("ExtensionHost source push authorization", () => {
  it("stores a four-hour dev-session grant for extension main pushes", async () => {
    const { host, approvalQueue, extensionNode } = makeHost({ approvalDecision: "session" });
    const request = {
      caller: panelCtx("panel-1").caller,
      repoPath: extensionNode.relativePath,
      branch: "main",
      commit: "def456",
    };

    await expect(host.authorizeSourcePush(request)).resolves.toEqual({ allowed: true });
    await expect(host.authorizeSourcePush({ ...request, commit: "def457" })).resolves.toEqual({ allowed: true });
    await expect(host.authorizeSourcePush({
      ...request,
      caller: panelCtx("panel-2").caller,
      commit: "def458",
    })).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      extensionDiff: expect.objectContaining({
        previousSha: "abc123",
        sha: "def456",
        push: expect.objectContaining({
          ref: "main",
          pushedBy: "panel-1",
        }),
      }),
    }));
  });

  it("does not gate non-active extension branches", async () => {
    const { host, approvalQueue, extensionNode } = makeHost();

    await expect(host.authorizeSourcePush({
      caller: panelCtx("panel-1").caller,
      repoPath: extensionNode.relativePath,
      branch: "feature",
      commit: "def456",
    })).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("allows DO callers to request extension source-push approval", async () => {
    const { host, approvalQueue, extensionNode } = makeHost({ approvalDecision: "session" });

    await expect(host.authorizeSourcePush({
      caller: doCtx().caller,
      repoPath: extensionNode.relativePath,
      branch: "main",
      commit: "def456",
    })).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
      callerKind: "do",
      repoPath: "workers/agent-worker",
    }));
  });
});

const declare = (
  name: string,
  opts: { ref?: string; enabled?: boolean } = {},
) => [{ source: name, ref: opts.ref ?? "main", enabled: opts.enabled ?? true }];

describe("ExtensionHost reconcileDeclared", () => {
  it("leaves declared extensions pending when the joint approval is denied", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      installed: false,
      approvalDecision: "deny",
    });
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "extension-batch",
      trigger: "startup",
      extensions: [expect.objectContaining({ extensionName: extensionNode.name })],
    }));
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      activeBundleKey: null,
      status: "pending-approval",
    });
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("builds and activates declared extensions when the joint approval is granted", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      installed: false,
      approvalDecision: "once",
    });
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "extension-batch",
      trigger: "startup",
    }));
    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "main");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: extensionNode.name }));
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      enabled: true,
      activeBundleKey: "candidate-key",
    });
  });

  it("starts an already-approved declared extension without prompting", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost();
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: extensionNode.name }));
  });

  it("stops an approved declared extension when declared enabled:false", async () => {
    const { host, approvalQueue, extensionNode } = makeHost();
    const stop = vi.spyOn(host.processes, "stop").mockResolvedValue(undefined);
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await host.reconcileDeclared(declare(extensionNode.name, { enabled: false }));

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(extensionNode.name);
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      enabled: false,
      status: "stopped",
    });
  });

  it("removes a registry entry that is no longer declared", async () => {
    const { host, extensionNode } = makeHost();
    const stop = vi.spyOn(host.processes, "stop").mockResolvedValue(undefined);

    await host.reconcileDeclared([]);

    expect(stop).toHaveBeenCalledWith(extensionNode.name);
    expect(host.registry.get(extensionNode.name)).toBeNull();
  });

  it("rebuilds an already-approved extension whose dependency EV changed, without prompting", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      activeEv: "ev-current",
      depEv: "ev-runtime-next",
      activeDepEv: "ev-runtime-old",
    });
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "main");
  });
});

describe("ExtensionHost activation", () => {
  it("starts the approved active bundle instead of rebuilding the current ref", async () => {
    const { host, buildSystem, extensionNode } = makeHost();
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.activate(extensionNode.name);

    expect(buildSystem.getBuildByKey).toHaveBeenCalledWith("bundle-key");
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      name: extensionNode.name,
      bundlePath: expect.stringContaining("bundle-key"),
    }));
  });

  it("surfaces running extension inspector URLs in workspace unit status", () => {
    const { host, extensionNode } = makeHost();
    vi.spyOn(host.processes, "listRunning").mockReturnValue([{
      name: extensionNode.name,
      methods: ["blame"],
      hasFetch: true,
      health: null,
      inspectorUrl: "ws://127.0.0.1:9229/abcdef",
    }]);

    expect(host.listWorkspaceUnits()[0]).toMatchObject({
      name: extensionNode.name,
      inspectorUrl: "ws://127.0.0.1:9229/abcdef",
      methods: ["blame"],
      hasFetch: true,
    });
  });

  it("invokes extension APIs over the connected WebSocket transport when available", async () => {
    let hostRef: ExtensionHost;
    const extensionTransport = {
      call: vi.fn(async (name: string, _method: string, _apiMethod: string, _args: unknown[], invocation: { invocationToken?: string }) => {
        expect(invocation.invocationToken).toEqual(expect.any(String));
        expect(hostRef.resolveActiveInvocation(name, invocation.invocationToken!)).toEqual(expect.objectContaining({
          extensionName: name,
          method: "blame",
        }));
        return "transport-result";
      }),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    hostRef = host;
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", ["README.md"]),
    ).resolves.toBe("transport-result");

    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.invoke",
      "blame",
      ["README.md"],
      expect.objectContaining({
        extensionName: extensionNode.name,
        method: "blame",
        invocationToken: expect.any(String),
      }),
    );
    const invocation = extensionTransport.call.mock.calls[0]![4] as { invocationToken: string };
    expect(host.resolveActiveInvocation(extensionNode.name, invocation.invocationToken)).toBeNull();
  });

  it("records extension invocation failures with stack context", async () => {
    const err = new Error("boom");
    (err as NodeJS.ErrnoException).code = "EBOOM";
    const extensionTransport = { call: vi.fn(async () => { throw err; }) };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []),
    ).rejects.toThrow(`Extension ${extensionNode.name}.blame invocation failed: boom`);

    expect(host.listWorkspaceUnitLogs(extensionNode.name, { level: "error" })).toEqual([
      expect.objectContaining({
        level: "error",
        source: "console",
        message: expect.stringContaining("invocation failed: boom"),
        fields: expect.objectContaining({
          method: "blame",
          callerId: "panel-1",
          callerKind: "panel",
          code: "EBOOM",
          stack: expect.stringContaining("Caused by: Error: boom"),
        }),
      }),
    ]);
  });

  it("fails with ENOEXT and never prompts when invoking an undeclared extension", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      extensionTransport,
      installed: false,
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", ["README.md"]),
    ).rejects.toMatchObject({ code: "ENOEXT" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(extensionTransport.call).not.toHaveBeenCalled();
  });

  it("fails with ENOEXT when invoking a disabled extension", async () => {
    const { host, approvalQueue, extensionNode } = makeHost({
      enabled: false,
      status: "stopped",
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []),
    ).rejects.toMatchObject({ code: "ENOEXT" });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("fails with ENOTREADY when an enabled extension is not running", async () => {
    const { host, extensionNode } = makeHost();
    vi.spyOn(host.processes, "isRunning").mockReturnValue(false);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []),
    ).rejects.toMatchObject({ code: "ENOTREADY" });
  });

  it("streams extension fetch request bodies through chunk RPC", async () => {
    const requestBody = Buffer.from([0, 1, 2, 255]);
    const responseBody = Buffer.from([255, 2, 1, 0]);
    const capturedChunks: Buffer[] = [];
    let service: ReturnType<ExtensionHost["createServiceDefinition"]>;
    const extensionTransport = {
      call: vi.fn(async (_name: string, method: string, request: unknown) => {
        expect(method).toBe("extension.fetch");
        const body = (request as { body?: { __stream?: true; id?: string } }).body;
        expect(body).toMatchObject({ __stream: true });
        expect(typeof body?.id).toBe("string");
        while (true) {
          const next = await service.handler(
            { caller: createVerifiedCaller(extensionNode.name, "extension" ) } as any,
            "fetchRequestBodyChunk",
            [body!.id!],
          ) as { done: boolean; chunk?: { __bin: true; data: string } };
          if (next.done) break;
          expect(next.chunk).toMatchObject({ __bin: true });
          capturedChunks.push(Buffer.from(next.chunk!.data, "base64"));
        }
        return {
          status: 201,
          headers: { "content-type": "application/octet-stream" },
          body: { __bin: true, data: responseBody.toString("base64") },
        };
      }),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    service = host.createServiceDefinition();
    const req = Readable.from([requestBody]) as any;
    req.method = "POST";
    req.url = "/_r/ext/%40workspace-extensions%2Fgit-tools/upload?x=1";
    req.headers = { "content-type": "application/octet-stream" };
    const res = {
      statusCode: 0,
      headers: undefined as Record<string, string> | undefined,
      body: undefined as Buffer | undefined,
      writeHead(status: number, headers: Record<string, string>) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body: Buffer | string) {
        this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
      },
    };

    await host.handleExtensionHttpRequest(
      req,
      res as any,
      extensionNode.name,
      "/upload",
      panelCtx("panel-1").caller,
    );

    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.fetch",
      expect.objectContaining({
        body: expect.objectContaining({ __stream: true }),
      }),
      expect.objectContaining({ method: "fetch" }),
    );
    expect(Buffer.concat(capturedChunks)).toEqual(requestBody);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual(responseBody);
  });

  it("streams extension fetch responses through chunk RPC", async () => {
    const responseChunks = [
      Buffer.from("hello "),
      Buffer.alloc(70 * 1024, 7),
      Buffer.from(" done"),
    ];
    const expectedBody = Buffer.concat(responseChunks);
    let closeCalled = false;
    const extensionTransport = {
      call: vi.fn(async (_name: string, method: string) => {
        if (method === "extension.fetch") {
          return {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
            body: { __stream: true, id: "response-stream-1" },
          };
        }
        if (method === "extension.fetchResponseBodyChunk") {
          const chunk = responseChunks.shift();
          if (!chunk) return { done: true };
          return {
            done: false,
            chunk: { __bin: true, data: chunk.toString("base64") },
          };
        }
        if (method === "extension.fetchResponseBodyClose") {
          closeCalled = true;
          return null;
        }
        throw new Error(`Unexpected extension method: ${method}`);
      }),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    const req = Readable.from([]) as any;
    req.method = "GET";
    req.url = "/_r/ext/%40workspace-extensions%2Fgit-tools/download";
    req.headers = {};
    class TestResponse extends Writable {
      statusCode = 0;
      headers: Record<string, string> | undefined;
      chunks: Buffer[] = [];
      writeHead(status: number, headers: Record<string, string>) {
        this.statusCode = status;
        this.headers = headers;
      }
      _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      }
      body() {
        return Buffer.concat(this.chunks);
      }
    }
    const res = new TestResponse();

    await host.handleExtensionHttpRequest(
      req,
      res as any,
      extensionNode.name,
      "/download",
      panelCtx("panel-1").caller,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(res.body()).toEqual(expectedBody);
    expect(closeCalled).toBe(true);
    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.fetchResponseBodyChunk",
      "response-stream-1",
    );
  });

  it("accepts extension event, health, and log requests over RPC", async () => {
    const { host, extensionNode, eventService } = makeHost();
    const service = host.createServiceDefinition();
    const extensionCtx = { caller: createVerifiedCaller(extensionNode.name, "extension") };

    const markReady = vi.spyOn(host.processes, "markReady");

    await service.handler(extensionCtx as any, "ready", [{ methods: ["confirm"], hasFetch: true }]);
    await service.handler(extensionCtx as any, "emit", ["changed", { ok: true }]);
    await service.handler(extensionCtx as any, "health", ["degraded", { summary: "Waiting" }]);
    await service.handler(extensionCtx as any, "log", ["warn", "Something happened", { code: "TEST" }]);

    expect(markReady).toHaveBeenCalledWith(extensionNode.name, {
      methods: ["confirm"],
      hasFetch: true,
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      `extensions:${extensionNode.name}::changed`,
      { ok: true },
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "extensions:health",
      expect.objectContaining({
        name: extensionNode.name,
        health: expect.objectContaining({ state: "degraded", summary: "Waiting" }),
      }),
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "workspace:unit-log",
      expect.objectContaining({
        unitName: extensionNode.name,
        level: "warn",
        message: "Something happened",
        fields: { code: "TEST" },
      }),
    );
  });
});
