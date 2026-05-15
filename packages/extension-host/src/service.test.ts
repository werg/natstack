import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ExtensionHost } from "./service.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-host-"));
}

function makeHost(overrides: {
  approvalDecision?: "once" | "session" | "version" | "repo" | "deny";
  activeEv?: string | null;
  depEv?: string | null;
  activeDepEv?: string | null;
  activeExternalDeps?: Record<string, string>;
  candidateExternalDeps?: Record<string, string>;
  extensionTransport?: { call: ReturnType<typeof vi.fn> };
  installed?: boolean;
  enabled?: boolean;
  status?: "running" | "stopped" | "building" | "error";
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
    JSON.stringify({ name: extensionNode.name, version: "1.0.0" }),
  );
  const approvalQueue = {
    request: vi.fn(async () => overrides.approvalDecision ?? "once"),
    requestUserland: vi.fn(async () => ({ kind: "choice" as const, choice: "allow" })),
  };
  const eventService = { emit: vi.fn(), getOrCreateSubscriber: vi.fn(), subscribe: vi.fn() };
  const userlandApprovalGrantStore = {
    lookup: vi.fn(() => null),
    record: vi.fn(),
  };
  const buildSystem = {
    getBuild: vi.fn(async () => ({
      bundlePath: path.join(statePath, "builds", "candidate-key", "bundle.js"),
      dir: path.join(statePath, "builds", "candidate-key"),
      metadata: { ev: "ev-candidate", runtimeDepsKey: "runtime-candidate" },
    })),
    getBuildByKey: vi.fn((key: string) => key === "bundle-key" || key === "candidate-key"
      ? {
          bundlePath: path.join(statePath, "builds", key, "bundle.js"),
          dir: path.join(statePath, "builds", key),
          metadata: {
            ev: key === "candidate-key" ? "ev-candidate" : (overrides.activeEv ?? "ev-current"),
            runtimeDepsKey: key === "candidate-key" ? "runtime-candidate" : "runtime-key",
          },
        }
      : null),
    getEffectiveVersion: vi.fn((name: string) => {
      if (name === extensionNode.name) return overrides.activeEv ?? "ev-current";
      if (name === "@workspace/runtime") return overrides.depEv ?? "ev-runtime";
      return null;
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
    userlandApprovalGrantStore,
    codeIdentityResolver: {
      resolveByCallerId: vi.fn((callerId: string) => ({
        callerId,
        callerKind: "panel" as const,
        repoPath: "panels/dev",
        effectiveVersion: "panel-ev",
      })),
    },
    getGatewayUrl: () => "http://127.0.0.1:3000",
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
      activeRuntimeDepsKey: "runtime-key",
      enabled: overrides.enabled ?? true,
      status: overrides.status ?? "running",
      lastError: overrides.status === "error" ? "previous failure" : null,
    });
  }
  return { host, approvalQueue, buildSystem, extensionNode, eventService, userlandApprovalGrantStore };
}

describe("ExtensionHost source push authorization", () => {
  it("stores a four-hour dev-session grant for extension main pushes", async () => {
    const { host, approvalQueue, extensionNode } = makeHost({ approvalDecision: "session" });
    const request = {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: extensionNode.relativePath,
      branch: "main",
      commit: "def456",
    };

    await expect(host.authorizeSourcePush(request)).resolves.toEqual({ allowed: true });
    await expect(host.authorizeSourcePush({ ...request, commit: "def457" })).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
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
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: extensionNode.relativePath,
      branch: "feature",
      commit: "def456",
    })).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

describe("ExtensionHost built-in extension bootstrap", () => {
  it("records missing built-in extensions as pending approval without building", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({ installed: false });
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.ensureBuiltInExtensions([extensionNode.name]);

    const entry = host.registry.get(extensionNode.name);
    expect(entry).toMatchObject({
      name: extensionNode.name,
      enabled: false,
      activeBundleKey: null,
      activeEv: null,
      status: "pending-approval",
    });
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("preserves a user-disabled built-in extension", async () => {
    const { host, buildSystem, extensionNode } = makeHost({
      enabled: false,
      status: "error",
    });

    await host.ensureBuiltInExtensions([extensionNode.name]);

    expect(host.registry.get(extensionNode.name)).toMatchObject({
      enabled: false,
      status: "error",
      lastError: "previous failure",
      activeBundleKey: "bundle-key",
    });
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
  });

  it("builds enabled built-ins that do not yet have an active bundle", async () => {
    const { host, buildSystem, extensionNode } = makeHost({
      activeBundleKey: null,
      status: "building",
    });
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.ensureBuiltInExtensions([extensionNode.name]);

    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, undefined);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      name: extensionNode.name,
      bundlePath: expect.stringContaining("candidate-key"),
    }));
  });
});

describe("ExtensionHost update", () => {
  it("does not prompt or rebuild when the active EV and dependency EVs are current", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      activeEv: "ev-current",
      depEv: "ev-runtime",
    });

    await host.update({ callerId: "panel-1", callerKind: "panel" }, extensionNode.name);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
  });

  it("prompts with dependency change layers before rebuilding", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      activeEv: "ev-current",
      depEv: "ev-runtime-next",
      activeDepEv: "ev-runtime-old",
      activeExternalDeps: { zod: "3.22.4" },
      candidateExternalDeps: { zod: "3.23.8", chalk: "5.3.0" },
    });
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.update({ callerId: "panel-1", callerKind: "panel" }, extensionNode.name);

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "extension",
      action: "update",
      workspaceDepChanges: [{
        name: "@workspace/runtime",
        fromEv: "ev-runtime-old",
        toEv: "ev-runtime-next",
      }],
      externalDepChanges: [
        { name: "chalk", fromVersion: null, toVersion: "5.3.0" },
        { name: "zod", fromVersion: "3.22.4", toVersion: "3.23.8" },
      ],
      extensionDiff: null,
      candidateRuntimeDepsKey: null,
    }));
    expect(approvalQueue.request.mock.invocationCallOrder[0]!).toBeLessThan(
      buildSystem.getBuild.mock.invocationCallOrder[0]!,
    );
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
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke({ callerId: "panel-1", callerKind: "panel" }, extensionNode.name, "blame", ["README.md"]),
    ).resolves.toBe("transport-result");

    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.invoke",
      "blame",
      ["README.md"],
      expect.objectContaining({
        extensionName: extensionNode.name,
        method: "blame",
      }),
    );
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
            { callerId: extensionNode.name, callerKind: "extension" } as any,
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
      { callerId: "panel-1", callerKind: "panel" },
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
      { callerId: "panel-1", callerKind: "panel" },
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

  it("accepts extension event, health, log, and caller approval requests over RPC", async () => {
    const { host, extensionNode, eventService, approvalQueue, userlandApprovalGrantStore } = makeHost();
    const service = host.createServiceDefinition();
    const extensionCtx = { callerId: extensionNode.name, callerKind: "extension" as const };
    const invocation = {
      requestId: "req-1",
      extensionName: extensionNode.name,
      method: "confirm",
      caller: { callerId: "panel-1", callerKind: "panel" as const },
      userlandCaller: {
        callerId: "panel-1",
        callerKind: "panel" as const,
        repoPath: "panels/dev",
        effectiveVersion: "panel-ev",
      },
    };
    const req = {
      subject: { id: "dangerous-action", label: "Dangerous action" },
      title: "Allow action?",
      options: [{ value: "allow", label: "Allow" }],
    };

    const markReady = vi.spyOn(host.processes, "markReady");

    await service.handler(extensionCtx as any, "ready", [{ methods: ["confirm"], hasFetch: true }]);
    await service.handler(extensionCtx as any, "emit", ["changed", { ok: true }]);
    await service.handler(extensionCtx as any, "health", ["degraded", { summary: "Waiting" }]);
    await service.handler(extensionCtx as any, "log", ["warn", "Something happened", { code: "TEST" }]);
    await expect(
      service.handler(extensionCtx as any, "approvalForCaller", [invocation, req]),
    ).resolves.toEqual({ kind: "choice", choice: "allow" });

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
    expect(approvalQueue.requestUserland).toHaveBeenCalledWith(expect.objectContaining({
      principal: invocation.userlandCaller,
      subject: expect.objectContaining({
        id: expect.stringContaining("dangerous-action"),
      }),
    }));
    expect(userlandApprovalGrantStore.record).toHaveBeenCalled();
  });
});
