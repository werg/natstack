import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServiceDispatcher,
  type ServiceContext,
  type VerifiedCodeIdentity,
} from "@natstack/shared/serviceDispatcher";
import type { RpcEnvelope, RpcMessage } from "@natstack/rpc";
import { IpcDispatcher } from "./ipcDispatcher.js";

const ipcHandlers = new Map<string, (...args: never[]) => void>();

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: never[]) => void) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

function makeWebContents(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn(),
  };
}

function rpcEnvelope(
  from: string,
  callerKind: "server" | "shell" | "app" | "panel" | "unknown",
  message: RpcMessage,
  delivery?: Pick<RpcEnvelope["delivery"], "idempotencyKey" | "readOnly">,
  target = "main"
): RpcEnvelope {
  const caller = { callerId: from, callerKind };
  return {
    from,
    target,
    delivery: { caller, ...delivery },
    provenance: [caller],
    message,
  };
}

function expectSentRpcMessage(
  wc: ReturnType<typeof makeWebContents>,
  target: string,
  message: RpcMessage
): void {
  expect(wc.send).toHaveBeenCalledWith(
    "natstack:rpc:message",
    expect.objectContaining({
      from: "main",
      target,
      message,
    })
  );
}

function makeDispatcher(opts: {
  resolve: (
    webContentsId: number
  ) => { callerId: string; callerKind: "shell" | "panel" | "app" } | null;
  getCodeIdentityForCaller?: (callerId: string) => VerifiedCodeIdentity | null;
  getWebContentsForCaller?: (callerId: string) => ReturnType<typeof makeWebContents> | null;
  call?: ReturnType<typeof vi.fn>;
  callAs?: ReturnType<typeof vi.fn>;
  addMessageListener?: ReturnType<typeof vi.fn>;
  configureDispatcher?: (dispatcher: ServiceDispatcher) => void;
  authorizeAppServerCall?: (
    callerId: string,
    service: string,
    method: string,
    args: readonly unknown[]
  ) => void;
  onServerRpcResult?: ReturnType<typeof vi.fn>;
  openPanelSession?: ReturnType<typeof vi.fn>;
  getPanelRuntimeConnection?: (
    panelId: string
  ) => { runtimeEntityId: string; connectionId: string } | undefined;
}) {
  ipcHandlers.clear();
  const dispatcher = new ServiceDispatcher();
  opts.configureDispatcher?.(dispatcher);
  dispatcher.markInitialized();
  const serverClient = {
    call: opts.call ?? vi.fn(async () => ({ ok: "shell" })),
    callAs: opts.callAs ?? vi.fn(async () => ({ ok: "app" })),
    stream: vi.fn(async () => new Response()),
    addMessageListener: opts.addMessageListener ?? vi.fn(() => vi.fn()),
    openPanelSession:
      opts.openPanelSession ??
      vi.fn(async () => ({
        send: vi.fn(),
        onMessage: vi.fn(() => vi.fn()),
        status: () => "connected" as const,
        isClosed: () => false,
        close: vi.fn(),
      })),
    isConnected: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => "connected" as const),
    close: vi.fn(async () => {}),
  };
  const eventService = { registerSubscriber: vi.fn() };
  new IpcDispatcher({
    dispatcher,
    serverClient,
    getShellWebContents: () => null,
    resolveCallerForWebContents: opts.resolve,
    getCodeIdentityForCaller: opts.getCodeIdentityForCaller,
    getWebContentsForCaller: (opts.getWebContentsForCaller ?? (() => null)) as never,
    getPanelRuntimeConnection: opts.getPanelRuntimeConnection,
    authorizeAppServerCall: opts.authorizeAppServerCall,
    onServerRpcResult: opts.onServerRpcResult,
    eventService: eventService as never,
  });
  return { serverClient, eventService };
}

describe("IpcDispatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ipcHandlers.clear();
  });

  it("forwards app renderer server RPC through an app-scoped server client", async () => {
    const appWc = makeWebContents(10);
    const callAs = vi.fn(async () => ({ workspace: "ok" }));
    const { serverClient } = makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-1",
        fromId: "@workspace-apps/shell",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "workspace",
        "getInfo",
        []
      );
    });
    expect(serverClient.call).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expectSentRpcMessage(appWc, "@workspace-apps/shell", {
        type: "response",
        requestId: "req-1",
        result: { workspace: "ok" },
      });
    });
  });

  it("forwards the workspace shell renderer panelTree RPC as the apps/shell app principal", async () => {
    // The desktop workspace shell renders as the apps/shell app view, so its
    // panelTree call is scoped to its own app principal via callAs (no shell→app
    // proxy). This is the post-relabel path that replaced the deleted proxy.
    const shellWc = makeWebContents(20);
    const call = vi.fn();
    const callAs = vi.fn(async () => ({ rootPanels: [] }));
    const onServerRpcResult = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      call,
      callAs,
      onServerRpcResult,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: shellWc } as never,
      rpcEnvelope("shell", "shell", {
        type: "request",
        requestId: "req-paneltree",
        fromId: "@workspace-apps/shell",
        method: "panelTree.getTreeSnapshot",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "panelTree",
        "getTreeSnapshot",
        []
      );
    });
    expect(call).not.toHaveBeenCalled();
    expect(onServerRpcResult).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        service: "panelTree",
        method: "getTreeSnapshot",
      })
    );
    await vi.waitFor(() => {
      expectSentRpcMessage(shellWc, "shell", {
        type: "response",
        requestId: "req-paneltree",
        result: { rootPanels: [] },
      });
    });
  });

  it("forwards a native-host shell server RPC on the admin connection (no shell→app proxy)", async () => {
    // electron-main / bootstrap launch gate are native-host `shell` principals;
    // they reach the server via the admin connection (plain call), never via the
    // deleted shell→app panelTree proxy.
    const shellWc = makeWebContents(21);
    const call = vi.fn(async () => ({ ok: true }));
    const callAs = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "shell", callerKind: "shell" }),
      call,
      callAs,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: shellWc } as never,
      rpcEnvelope("shell", "shell", {
        type: "request",
        requestId: "req-shell-server",
        fromId: "shell",
        method: "workspace.hostTargets.beginLaunch",
        args: ["electron"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(call).toHaveBeenCalledWith("workspace", "hostTargets.beginLaunch", ["electron"]);
    });
    expect(callAs).not.toHaveBeenCalled();
  });

  it("relays a panel renderer over its own panel-principal session, not the shell/app channel", async () => {
    const panelWc = makeWebContents(11);
    const callAs = vi.fn();
    const call = vi.fn();
    const panelSend = vi.fn();
    const openPanelSession = vi.fn(async () => ({
      send: panelSend,
      onMessage: vi.fn(() => vi.fn()),
      status: () => "connected" as const,
      isClosed: () => false,
      close: vi.fn(),
    }));
    makeDispatcher({
      resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
      getWebContentsForCaller: () => panelWc,
      getPanelRuntimeConnection: () => ({ runtimeEntityId: "entity-1", connectionId: "conn-1" }),
      openPanelSession,
      call,
      callAs,
    });

    const envelope = rpcEnvelope("panel-1", "panel", {
      type: "request",
      requestId: "req-1",
      fromId: "panel-1",
      method: "workspace.getInfo",
      args: [],
    } satisfies RpcMessage);
    ipcHandlers.get("natstack:rpc:send")?.({ sender: panelWc } as never, envelope as never);

    await vi.waitFor(() => {
      expect(openPanelSession).toHaveBeenCalledWith("entity-1", "conn-1");
      expect(panelSend).toHaveBeenCalledWith(envelope);
    });
    // The panel's full surface rides its own session — it never reaches the
    // shell/app server path (call / callAs).
    expect(call).not.toHaveBeenCalled();
    expect(callAs).not.toHaveBeenCalled();
  });

  it("error-responds (not silently drops) a panel envelope with no runtime lease", async () => {
    const panelWc = makeWebContents(12);
    makeDispatcher({
      resolve: () => ({ callerId: "panel-2", callerKind: "panel" }),
      getWebContentsForCaller: () => panelWc,
      getPanelRuntimeConnection: () => undefined,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: panelWc } as never,
      rpcEnvelope("panel-2", "panel", {
        type: "request",
        requestId: "req-2",
        fromId: "panel-2",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(panelWc.send).toHaveBeenCalledWith(
        "natstack:rpc:message",
        expect.objectContaining({
          message: expect.objectContaining({ type: "response", requestId: "req-2" }),
        })
      );
    });
  });

  it("denies app server fs RPC before forwarding when authorization fails", async () => {
    const appWc = makeWebContents(14);
    const callAs = vi.fn();
    const authorizeAppServerCall = vi.fn(() => {
      throw new Error("fs.readFile requires app capability 'fs-read'");
    });
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
      authorizeAppServerCall,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-fs-denied",
        fromId: "@workspace-apps/shell",
        method: "fs.readFile",
        args: ["/hello.txt", "utf8"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expectSentRpcMessage(appWc, "@workspace-apps/shell", {
        type: "response",
        requestId: "req-fs-denied",
        error: "fs.readFile requires app capability 'fs-read'",
      });
    });
    expect(authorizeAppServerCall).toHaveBeenCalledWith("@workspace-apps/shell", "fs", "readFile", [
      "/hello.txt",
      "utf8",
    ]);
    expect(callAs).not.toHaveBeenCalled();
  });

  it("forwards app server fs RPC after authorization succeeds", async () => {
    const appWc = makeWebContents(15);
    const callAs = vi.fn(async () => "hello");
    const authorizeAppServerCall = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
      authorizeAppServerCall,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-fs-ok",
        fromId: "@workspace-apps/shell",
        method: "fs.readFile",
        args: ["/hello.txt", "utf8"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "fs",
        "readFile",
        ["/hello.txt", "utf8"]
      );
    });
    expect(authorizeAppServerCall).toHaveBeenCalledWith("@workspace-apps/shell", "fs", "readFile", [
      "/hello.txt",
      "utf8",
    ]);
    await vi.waitFor(() => {
      expectSentRpcMessage(appWc, "@workspace-apps/shell", {
        type: "response",
        requestId: "req-fs-ok",
        result: "hello",
      });
    });
  });

  it("forwards IPC delivery metadata as server call options", async () => {
    const appWc = makeWebContents(17);
    const callAs = vi.fn(async () => "ok");
    const request = {
      type: "request",
      requestId: "req-meta",
      fromId: "@workspace-apps/shell",
      method: "fs.readFile",
      args: ["/hello.txt", "utf8"],
    } satisfies RpcMessage;
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      callAs,
      authorizeAppServerCall: vi.fn(),
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", request, {
        idempotencyKey: "idem-1",
        readOnly: true,
      }) as never
    );

    await vi.waitFor(() => {
      expect(callAs).toHaveBeenCalledWith(
        { callerId: "@workspace-apps/shell", callerKind: "app" },
        "fs",
        "readFile",
        ["/hello.txt", "utf8"],
        { idempotencyKey: "idem-1", readOnly: true }
      );
    });
    expect(request).not.toHaveProperty("idempotencyKey");
    expect(request).not.toHaveProperty("readOnly");
  });

  it("attaches app source identity to Electron-local service dispatch", async () => {
    const appWc = makeWebContents(13);
    let seenContext: ServiceContext | null = null;
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getCodeIdentityForCaller: () => ({
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      }),
      configureDispatcher: (dispatcher) => {
        dispatcher.registerService({
          name: "app",
          description: "test app service",
          policy: { allowed: ["app"] },
          methods: {},
          handler: async (ctx) => {
            seenContext = ctx;
            return { ok: true };
          },
        });
      },
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-local",
        fromId: "@workspace-apps/shell",
        method: "app.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() =>
      expect(seenContext?.caller.code).toMatchObject({
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      })
    );
  });

  it("bridges server-originated app messages back to the current app WebContents", async () => {
    const appWc = makeWebContents(12);
    const listenerBox: { current?: (envelope: RpcEnvelope) => void } = {};
    const addMessageListener = vi.fn((_caller, nextListener) => {
      listenerBox.current = nextListener;
      return vi.fn();
    });
    makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
      addMessageListener,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-1",
        fromId: "@workspace-apps/shell",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage) as never
    );
    await vi.waitFor(() => expect(listenerBox.current).toBeTruthy());
    const emitToApp = listenerBox.current;
    if (!emitToApp) throw new Error("missing app message listener");

    const eventEnvelope = rpcEnvelope(
      "main",
      "server",
      {
        type: "event",
        fromId: "main",
        event: "workspace:changed",
        payload: { id: "ws" },
      },
      undefined,
      "@workspace-apps/shell"
    );
    emitToApp(eventEnvelope);

    expect(appWc.send).toHaveBeenCalledWith("natstack:rpc:message", eventEnvelope);
  });

  it("registers an IPC event subscriber for app-backed shell views", async () => {
    const appWc = makeWebContents(16);
    const { eventService } = makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      rpcEnvelope("@workspace-apps/shell", "app", {
        type: "request",
        requestId: "req-local-events",
        fromId: "@workspace-apps/shell",
        method: "events.subscribe",
        args: ["workspace:revision-bumped"],
      } satisfies RpcMessage) as never
    );

    await vi.waitFor(() => {
      expect(eventService.registerSubscriber).toHaveBeenCalledWith(
        "@workspace-apps/shell",
        expect.objectContaining({ callerKind: "app" })
      );
    });
  });
});
