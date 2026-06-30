import type { RpcClient, RpcConnectionStatus, RpcEventContext } from "@natstack/rpc";
import type { RecoveryKind } from "@natstack/rpc/protocol/recoveryCoordinator";
import type { WebRtcSession } from "@natstack/rpc/transports/webrtcClient";
import {
  loadShellCredential,
  reconnectViaWebRtc,
  type StoredShellCredential,
  type WebRtcConnection,
} from "@natstack/mobile-webrtc";
import { MobileRpcClient } from "./mobileTransport";

jest.mock("@natstack/mobile-webrtc", () => ({
  loadShellCredential: jest.fn(),
  reconnectViaWebRtc: jest.fn(),
}));

const mockLoadShellCredential = loadShellCredential as jest.MockedFunction<
  typeof loadShellCredential
>;
const mockReconnectViaWebRtc = reconnectViaWebRtc as jest.MockedFunction<typeof reconnectViaWebRtc>;

const storedCredential: StoredShellCredential = {
  deviceId: "dev_123",
  refreshToken: "refresh_123",
  pairing: {
    room: "room-123",
    fp: "AA".repeat(32),
    sig: "ws://127.0.0.1:8798",
    ice: "all",
    srv: "Test server",
  },
  pairedAt: 123,
};

function makeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    selfId: "shell:dev_123",
    call: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(() => jest.fn()),
    stream: jest.fn(),
    streamReadable: jest.fn(),
    ...overrides,
  } as unknown as RpcClient;
}

function makeSession(overrides: Partial<WebRtcSession> = {}): WebRtcSession {
  return {
    sid: "shell-session",
    callerId: jest.fn(() => "shell:dev_123"),
    isClosed: jest.fn(() => false),
    close: jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    send: jest.fn(),
    status: jest.fn(() => "connected" as RpcConnectionStatus),
    onStatusChange: jest.fn(() => jest.fn()),
    stream: jest.fn(),
    streamReadable: jest.fn(),
    ready: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as WebRtcSession;
}

function makeConnection(overrides: Partial<WebRtcConnection> = {}): WebRtcConnection {
  const session = overrides.session ?? makeSession();
  return {
    callerId: "shell:dev_123",
    deviceId: "dev_123",
    rpc: overrides.rpc ?? makeRpc(),
    session,
    transport:
      overrides.transport ??
      ({
        openSession: jest.fn(),
      } as unknown as WebRtcConnection["transport"]),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe("MobileRpcClient WebRTC transport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadShellCredential.mockResolvedValue(storedCredential);
  });

  it("loads the stored WebRTC credential, reconnects, and delegates RPC calls", async () => {
    const rpc = makeRpc({
      call: jest.fn(async () => ({ ok: true })),
    });
    const connection = makeConnection({ rpc });
    mockReconnectViaWebRtc.mockResolvedValue(connection);
    const client = new MobileRpcClient({});

    await client.connectAndWait();

    expect(mockLoadShellCredential).toHaveBeenCalledTimes(1);
    expect(mockReconnectViaWebRtc).toHaveBeenCalledWith(storedCredential, expect.any(Function));
    expect(client.selfId).toBe("shell:dev_123");
    expect(client.status).toBe("connected");
    await expect(client.call("main", "demo.hello", ["world"])).resolves.toEqual({ ok: true });
    expect(rpc.call).toHaveBeenCalledWith("main", "demo.hello", ["world"], undefined);
  });

  it("retries transient initial WebRTC reconnect failures", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const connection = makeConnection();
    mockReconnectViaWebRtc
      .mockRejectedValueOnce(new Error("signaling warming up"))
      .mockResolvedValueOnce(connection);
    const client = new MobileRpcClient({
      initialConnectionRetry: { maxMs: 1_000, delayMs: 1, maxDelayMs: 1 },
    });

    try {
      await expect(client.connectAndWait()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockReconnectViaWebRtc).toHaveBeenCalledTimes(2);
    expect(client.status).toBe("connected");
  });

  it("dispatches server events to subscribed local listeners and unsubscribes cleanly", async () => {
    const eventCallbacks = new Map<string, (event: RpcEventContext) => void>();
    const activeUnsub = jest.fn();
    const rpc = makeRpc({
      on: jest.fn((event: string, callback: (event: RpcEventContext) => void) => {
        eventCallbacks.set(event, callback);
        return activeUnsub;
      }),
    });
    mockReconnectViaWebRtc.mockResolvedValue(makeConnection({ rpc }));
    const client = new MobileRpcClient({});
    const listener = jest.fn();

    const unsubscribe = client.on("event:shell-approval:pending-changed", listener);
    await client.connectAndWait();
    eventCallbacks
      .get("event:shell-approval:pending-changed")!
      ({ payload: { pending: ["approval-1"] } } as RpcEventContext);

    expect(listener).toHaveBeenCalledWith({ payload: { pending: ["approval-1"] } });
    unsubscribe();
    expect(activeUnsub).toHaveBeenCalledTimes(1);
  });

  it("opens panel sessions over the existing pipe with fresh grant tokens", async () => {
    let openedOptions: Parameters<WebRtcConnection["transport"]["openSession"]>[0] | null = null;
    let tokenSeenByReady = "";
    const rpc = makeRpc({
      call: jest.fn(async () => ({ token: "panel-grant-123" })),
    });
    const panelSession = makeSession({
      ready: jest.fn(async () => {
        tokenSeenByReady = await openedOptions!.getToken();
      }),
    });
    const transport = {
      openSession: jest.fn((options) => {
        openedOptions = options;
        return panelSession;
      }),
    } as unknown as WebRtcConnection["transport"];
    mockReconnectViaWebRtc.mockResolvedValue(makeConnection({ rpc, transport }));
    const client = new MobileRpcClient({});

    await expect(client.openPanelSession("panel:runtime-1", "panel-conn-1")).resolves.toBe(
      panelSession
    );

    expect(transport.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "panel-conn-1",
        callerKind: "panel",
        clientPlatform: "mobile",
      })
    );
    expect(rpc.call).toHaveBeenCalledWith(
      "main",
      "auth.grantConnection",
      ["panel:runtime-1"],
      undefined
    );
    expect(tokenSeenByReady).toBe("panel-grant-123");
  });

  it("forwards WebRTC recovery notifications to registered listeners", async () => {
    let emitRecovery: ((kind: RecoveryKind) => void | Promise<void>) | undefined;
    mockReconnectViaWebRtc.mockImplementation(async (_stored, onRecovery) => {
      emitRecovery = onRecovery;
      return makeConnection();
    });
    const client = new MobileRpcClient({});
    const coldRecover = jest.fn();
    const resubscribe = jest.fn();
    client.onRecovery("cold-recover", coldRecover);
    client.onRecovery("resubscribe", resubscribe);

    await client.connectAndWait();
    await emitRecovery?.("cold-recover");
    await emitRecovery?.("resubscribe");

    expect(coldRecover).toHaveBeenCalledTimes(1);
    expect(resubscribe).toHaveBeenCalledTimes(1);
  });
});
