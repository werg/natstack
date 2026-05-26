import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServiceDispatcher,
  type ServiceContext,
  type VerifiedCodeIdentity,
} from "@natstack/shared/serviceDispatcher";
import type { RpcMessage } from "@natstack/rpc";
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
  };
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
}) {
  ipcHandlers.clear();
  const dispatcher = new ServiceDispatcher();
  opts.configureDispatcher?.(dispatcher);
  dispatcher.markInitialized();
  const serverClient = {
    call: opts.call ?? vi.fn(async () => ({ ok: "shell" })),
    callAs: opts.callAs ?? vi.fn(async () => ({ ok: "app" })),
    addMessageListener: opts.addMessageListener ?? vi.fn(() => vi.fn()),
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
    authorizeAppServerCall: opts.authorizeAppServerCall,
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
      "main" as never,
      {
        type: "request",
        requestId: "req-1",
        fromId: "@workspace-apps/shell",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage as never
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
    expect(appWc.send).toHaveBeenCalledWith("natstack:rpc:message", "main", {
      type: "response",
      requestId: "req-1",
      result: { workspace: "ok" },
    });
  });

  it("rejects panel renderers on the generic shell/app RPC channel", async () => {
    const panelWc = makeWebContents(11);
    const callAs = vi.fn();
    const call = vi.fn();
    makeDispatcher({
      resolve: () => ({ callerId: "panel-1", callerKind: "panel" }),
      call,
      callAs,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: panelWc } as never,
      "main" as never,
      {
        type: "request",
        requestId: "req-1",
        fromId: "panel-1",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage as never
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(call).not.toHaveBeenCalled();
    expect(callAs).not.toHaveBeenCalled();
    expect(panelWc.send).not.toHaveBeenCalled();
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
      "main" as never,
      {
        type: "request",
        requestId: "req-fs-denied",
        fromId: "@workspace-apps/shell",
        method: "fs.readFile",
        args: ["/hello.txt", "utf8"],
      } satisfies RpcMessage as never
    );

    await vi.waitFor(() => {
      expect(appWc.send).toHaveBeenCalledWith("natstack:rpc:message", "main", {
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
      "main" as never,
      {
        type: "request",
        requestId: "req-fs-ok",
        fromId: "@workspace-apps/shell",
        method: "fs.readFile",
        args: ["/hello.txt", "utf8"],
      } satisfies RpcMessage as never
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
    expect(appWc.send).toHaveBeenCalledWith("natstack:rpc:message", "main", {
      type: "response",
      requestId: "req-fs-ok",
      result: "hello",
    });
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
      "main" as never,
      {
        type: "request",
        requestId: "req-local",
        fromId: "@workspace-apps/shell",
        method: "app.getInfo",
        args: [],
      } satisfies RpcMessage as never
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
    const listenerBox: { current?: (fromId: string, message: RpcMessage) => void } = {};
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
      "main" as never,
      {
        type: "request",
        requestId: "req-1",
        fromId: "@workspace-apps/shell",
        method: "workspace.getInfo",
        args: [],
      } satisfies RpcMessage as never
    );
    await vi.waitFor(() => expect(listenerBox.current).toBeTruthy());
    const emitToApp = listenerBox.current;
    if (!emitToApp) throw new Error("missing app message listener");

    emitToApp("main", {
      type: "event",
      fromId: "main",
      event: "workspace:changed",
      payload: { id: "ws" },
    });

    expect(appWc.send).toHaveBeenCalledWith("natstack:rpc:message", "main", {
      type: "event",
      fromId: "main",
      event: "workspace:changed",
      payload: { id: "ws" },
    });
  });

  it("registers an IPC event subscriber for app-backed shell views", async () => {
    const appWc = makeWebContents(16);
    const { eventService } = makeDispatcher({
      resolve: () => ({ callerId: "@workspace-apps/shell", callerKind: "app" }),
      getWebContentsForCaller: () => appWc,
    });

    ipcHandlers.get("natstack:rpc:send")?.(
      { sender: appWc } as never,
      "main" as never,
      {
        type: "request",
        requestId: "req-local-events",
        fromId: "@workspace-apps/shell",
        method: "events.subscribe",
        args: ["workspace:revision-bumped"],
      } satisfies RpcMessage as never
    );

    await vi.waitFor(() => {
      expect(eventService.registerSubscriber).toHaveBeenCalledWith(
        "@workspace-apps/shell",
        expect.objectContaining({ callerKind: "app" })
      );
    });
  });
});
