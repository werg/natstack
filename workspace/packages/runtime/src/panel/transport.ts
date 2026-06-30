import {
  ELECTRON_LOCAL_SERVICE_NAMES,
  responseEnvelopeFor,
  type EnvelopeRpcTransport,
  type RpcEnvelope,
  type RpcRequest,
} from "@natstack/rpc";
import { createRecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";
import type { RecoveryCoordinator, RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";

/**
 * The host bridge a panel reaches its server through. A panel lives in a webview
 * and cannot touch the host's WebRTC `RTCPeerConnection` directly, so its RPC
 * crosses the webview boundary over the **shell bridge** — Electron
 * `contextBridge` IPC (`__natstackShell`) on desktop, the React-Native
 * `postMessage` bridge injected by `PanelWebView` on mobile. The host forwards
 * each panel's envelopes onto its single control channel as that panel's own
 * logical session (per-panel principal, lease, and recovery preserved exactly)
 * and delivers the demuxed inbound envelopes back via `onEnvelope`. There is no
 * panel-side socket and no direct `ws://…/rpc` connection.
 */
type NatstackShellBridge = {
  /** Post one RPC envelope to the host (→ this panel's logical session on the pipe). */
  postEnvelope: (envelope: RpcEnvelope) => void | Promise<void>;
  /** Subscribe to inbound envelopes the host demuxes for this panel's session. */
  onEnvelope: (handler: (envelope: RpcEnvelope) => void) => () => void;
  /** Optional recovery signals (resubscribe / cold-recover) raised by the host. */
  onRecovery?: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
  /**
   * Optional first-class streaming: the host physically streams the response
   * body over the **bulk channel** and returns a `Response`. When absent, the
   * RPC client transparently falls back to the duplex stream-request /
   * stream-frame envelope path over `postEnvelope`/`onEnvelope`.
   */
  stream?: (envelope: RpcEnvelope, signal?: AbortSignal | null) => Promise<Response>;
  /** Electron-only: IPC dispatch for electron-local services (kept as-is). */
  serviceCall?: (method: string, ...args: unknown[]) => Promise<unknown>;
};

export const recoveryCoordinator: RecoveryCoordinator = createRecoveryCoordinator();

function getShellBridge(): NatstackShellBridge {
  const shell = ((globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron) as
    | NatstackShellBridge
    | undefined;
  if (
    !shell ||
    typeof shell.postEnvelope !== "function" ||
    typeof shell.onEnvelope !== "function"
  ) {
    throw new Error(
      "NatStack shell bridge is not available (missing __natstackShell.postEnvelope/onEnvelope)"
    );
  }
  return shell;
}

/**
 * Services that panels should call through Electron main. `events` is local
 * for the shell, but panel event subscriptions must stay on the panel's logical
 * session so EventService has a delivery session for that caller.
 */
const electronLocalServices: ReadonlySet<string> = new Set(
  ELECTRON_LOCAL_SERVICE_NAMES.filter((service) => service !== "events")
);

function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  const envelope = value as Partial<RpcEnvelope> | null;
  const message = envelope?.message as { type?: unknown } | undefined;
  return (
    !!envelope &&
    typeof envelope === "object" &&
    typeof envelope.from === "string" &&
    typeof envelope.target === "string" &&
    !!message &&
    typeof message === "object" &&
    typeof message.type === "string"
  );
}

export function createPanelTransport(): EnvelopeRpcTransport {
  const shell = getShellBridge();
  const electronServiceCall =
    typeof shell.serviceCall === "function" ? shell.serviceCall.bind(shell) : undefined;
  const listeners = new Set<(envelope: RpcEnvelope) => void>();

  const deliver = (envelope: RpcEnvelope): void => {
    for (const listener of listeners) listener(envelope);
  };

  shell.onRecovery?.("resubscribe", () => recoveryCoordinator.run("resubscribe"));
  shell.onRecovery?.("cold-recover", () => recoveryCoordinator.run("cold-recover"));

  shell.onEnvelope((envelope) => {
    if (isRpcEnvelope(envelope)) deliver(envelope);
  });

  const transport: EnvelopeRpcTransport = {
    async send(envelope: RpcEnvelope): Promise<void> {
      // Route RPC requests to "main": Electron-local services go via IPC
      // through __natstackShell.serviceCall. Everything else rides the shell
      // bridge to the host, which muxes it onto the panel's logical session on
      // the control channel — so userland/workerd services need no static
      // routing edits and no panel-side socket exists.
      if (envelope.target === "main" && envelope.message.type === "request") {
        const request = envelope.message as RpcRequest;
        const dotIdx = request.method.indexOf(".");
        const service = dotIdx > 0 ? request.method.slice(0, dotIdx) : "";

        if (electronLocalServices.has(service)) {
          if (!electronServiceCall) {
            // Electron-local service called from a non-Electron context
            // (mobile, headless). Fail fast with a clear message instead
            // of sending to the server where it'd fail with a confusing
            // "Unknown service" error.
            deliver(
              responseEnvelopeFor(
                envelope,
                { callerId: "main", callerKind: "shell" },
                {
                  type: "response",
                  requestId: request.requestId,
                  error:
                    `Service '${service}' is an Electron-local service ` +
                    `and requires the Electron desktop app. It is not available ` +
                    `in this context.`,
                }
              )
            );
            return;
          }

          // Dispatch via Electron IPC and deliver a synthetic response
          void (async () => {
            try {
              const result = await electronServiceCall(request.method, ...(request.args ?? []));
              deliver(
                responseEnvelopeFor(
                  envelope,
                  { callerId: "main", callerKind: "shell" },
                  {
                    type: "response",
                    requestId: request.requestId,
                    result,
                  }
                )
              );
            } catch (err) {
              deliver(
                responseEnvelopeFor(
                  envelope,
                  { callerId: "main", callerKind: "shell" },
                  {
                    type: "response",
                    requestId: request.requestId,
                    error: err instanceof Error ? err.message : String(err),
                  }
                )
              );
            }
          })();
          return;
        }
      }

      await shell.postEnvelope(envelope);
    },

    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };

  // First-class streaming rides the bulk channel when the host exposes it.
  // Otherwise the RPC client falls back to the duplex envelope path above.
  if (typeof shell.stream === "function") {
    const streamFn = shell.stream.bind(shell);
    transport.stream = (envelope, signal) => streamFn(envelope, signal ?? null);
  }

  return transport;
}
