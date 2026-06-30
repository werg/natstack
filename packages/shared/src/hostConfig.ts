/**
 * HostConfig — resolved host/port configuration for a NatStack server.
 *
 * The gateway serves loopback HTTP only. Remote access is WebRTC (DTLS-encrypted,
 * paired by QR), so there is no HTTPS/TLS branch, no remote-server URL, and no
 * public-URL/protocol negotiation here. All panel-facing URL construction flows
 * through this config.
 */

export interface HostConfig {
  /** Protocol for panel-facing URLs — always http (the gateway is loopback). */
  protocol: "http";
  /** Address to bind server sockets to (127.0.0.1 loopback; 0.0.0.0 for LAN dev). */
  bindHost: string;
  /** The hostname panels are served on (e.g. "localhost", "127.0.0.1"). */
  externalHost: string;
  /** Internal host for server-to-server communication (always 127.0.0.1). */
  internalHost: "127.0.0.1";
  /** The gateway port that multiplexes HTTP/WS/git/workerd. */
  gatewayPort: number;
  /** The workerd port. */
  workerdPort: number;
}

/**
 * Resolve host config from environment or explicit values. The gateway
 * multiplexes panel HTTP, RPC, git, and workerd ingress on a single port.
 *
 * Environment variables:
 * - NATSTACK_HOST / --host: external hostname (sets bindHost to "0.0.0.0")
 * - NATSTACK_BIND_HOST / --bind-host: explicit bind address
 * - NATSTACK_GATEWAY_PORT / --gateway-port: gateway ingress port
 */
export function resolveHostConfig(opts: {
  workerdPort: number;
  gatewayPort?: number;
  host?: string;
  bindHost?: string;
}): HostConfig {
  const envHost = process.env["NATSTACK_HOST"] ?? opts.host;
  const envBindHost = process.env["NATSTACK_BIND_HOST"] ?? opts.bindHost;

  const externalHost = envHost ?? "localhost";
  const bindHost = envBindHost ?? (envHost ? "0.0.0.0" : "127.0.0.1");

  return {
    protocol: "http",
    bindHost,
    externalHost,
    internalHost: "127.0.0.1",
    gatewayPort: opts.gatewayPort ?? 0,
    workerdPort: opts.workerdPort,
  };
}
