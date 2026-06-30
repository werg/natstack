/**
 * `TransportManager` — the single-transport lifecycle owner that REPLACES
 * `composeTransports` (plan §1). With exactly one remote transport (WebRTC)
 * there is no routing or failover to do — `composeTransports` did static
 * predicate routing with health that followed only the fallback, and had zero
 * importers. This is its replacement: a thin owner around ONE transport that
 *
 *  - presents the `EnvelopeRpcTransport` surface upward UNCHANGED, so
 *    `createRpcClient`/`createHostedRuntime` are untouched;
 *  - drives a `DefaultRecoveryCoordinator` from the transport's recovery signal
 *    (cold-recover vs resubscribe), so consumers register resubscribe/
 *    cold-recover handlers in one place regardless of WS-vs-WebRTC underneath;
 *  - owns connect/close and exposes liveness, leaving reconnect + ICE-restart to
 *    the wrapped transport (which is closest to the ICE/DTLS/channel state).
 *
 * It deliberately does NOT stack a second transport as a backstop (fail-loud
 * rule: one mechanism per job). If the single transport dies, that is surfaced —
 * never silently covered.
 */

import type { EnvelopeRpcTransport, RpcConnectionStatus, RpcEnvelope } from "../types.js";
import {
  type RecoveryKind,
  createRecoveryCoordinator,
  type RecoveryCoordinator,
} from "../protocol/recoveryCoordinator.js";

/** A transport that also exposes imperative lifecycle + a recovery signal. */
export interface ManagedTransport extends EnvelopeRpcTransport {
  connect?(): Promise<void>;
  close?(): Promise<void> | void;
  onRecovery?(kind: RecoveryKind, handler: () => void | Promise<void>): () => void;
}

export interface TransportManager extends EnvelopeRpcTransport {
  /** Always provided by the manager (the base interface leaves these optional). */
  status(): RpcConnectionStatus;
  ready(): Promise<void>;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  /** The recovery coordinator consumers register resubscribe/cold-recover on. */
  readonly recovery: RecoveryCoordinator;
  /** Establish the underlying transport (idempotent). */
  connect(): Promise<void>;
  /** Tear it down. */
  close(): Promise<void>;
  /** The underlying transport (escape hatch — e.g. WebRTC `openSession`). */
  readonly transport: ManagedTransport;
}

export interface TransportManagerOptions {
  transport: ManagedTransport;
  recovery?: RecoveryCoordinator;
}

export function createTransportManager(options: TransportManagerOptions): TransportManager {
  const transport = options.transport;
  const recovery = options.recovery ?? createRecoveryCoordinator();

  // Bridge the transport's recovery signal into the coordinator. Both kinds are
  // forwarded; the transport decides which fires (bootId change / dirty session).
  if (transport.onRecovery) {
    const kinds: RecoveryKind[] = ["resubscribe", "cold-recover"];
    for (const kind of kinds) {
      transport.onRecovery(kind, () => recovery.run(kind));
    }
  }

  const manager: TransportManager = {
    recovery,
    transport,
    send(envelope: RpcEnvelope): Promise<void> {
      return transport.send(envelope);
    },
    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      return transport.onMessage(handler);
    },
    status(): RpcConnectionStatus {
      return transport.status?.() ?? "connected";
    },
    ready(): Promise<void> {
      return transport.ready?.() ?? Promise.resolve();
    },
    onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
      return transport.onStatusChange?.(handler) ?? (() => {});
    },
    ...(transport.stream
      ? { stream: (envelope: RpcEnvelope, signal?: AbortSignal | null): Promise<Response> => transport.stream!(envelope, signal) }
      : {}),
    // Forward streamReadable too: createRpcClient hard-throws when it's undefined,
    // so dropping it would 502 every mobile panel-asset request the moment this
    // manager is wired into the live path.
    ...(transport.streamReadable
      ? { streamReadable: (envelope: RpcEnvelope, signal?: AbortSignal | null) => transport.streamReadable!(envelope, signal) }
      : {}),
    async connect(): Promise<void> {
      await (transport.connect?.() ?? transport.ready?.() ?? Promise.resolve());
    },
    async close(): Promise<void> {
      await transport.close?.();
    },
  };

  return manager;
}
