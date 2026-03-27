/**
 * HostConfig — resolved host/port configuration for a NatStack server.
 *
 * Abstracts away whether panels are served on localhost (Electron local)
 * or on a remote host (remote server mode). All URL construction flows
 * through this config.
 */

export interface HostConfig {
  /** Protocol for panel-facing URLs */
  protocol: "http" | "https";
  /** Address to bind server sockets to ("127.0.0.1" local, "0.0.0.0" remote) */
  bindHost: string;
  /** The hostname panels are served on (e.g., "localhost", "my-server.example.com") */
  externalHost: string;
  /** Internal host for server-to-server communication (always 127.0.0.1) */
  internalHost: "127.0.0.1";
  /** The gateway port that multiplexes HTTP/WS/git/workerd */
  gatewayPort: number;
  /** The RPC WS port (may differ from gatewayPort in local mode) */
  rpcPort: number;
  /** The panel HTTP port */
  panelHttpPort: number;
  /** The git server port */
  gitPort: number;
  /** The workerd port */
  workerdPort: number;
  /** Path to TLS certificate file (enables HTTPS gateway) */
  tlsCert?: string;
  /** Path to TLS private key file (enables HTTPS gateway) */
  tlsKey?: string;
}

/**
 * Resolve host config from environment or explicit values.
 *
 * In local mode: all services run on localhost with separate ports.
 * In remote mode: gateway multiplexes everything on a single port/host.
 *
 * Environment variables:
 * - NATSTACK_HOST / --host: external hostname (sets bindHost to "0.0.0.0")
 * - NATSTACK_BIND_HOST / --bind-host: explicit bind address
 * - NATSTACK_PROTOCOL: "http" or "https"
 */
export function resolveHostConfig(opts: {
  remoteUrl?: string;
  rpcPort: number;
  panelHttpPort: number;
  gitPort: number;
  workerdPort: number;
  gatewayPort?: number;
  host?: string;
  bindHost?: string;
  protocol?: "http" | "https";
  tlsCert?: string;
  tlsKey?: string;
}): HostConfig {
  if (opts.remoteUrl) {
    const url = new URL(opts.remoteUrl);
    const port = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);
    const protocol = url.protocol === "https:" ? "https" as const : "http" as const;
    return {
      protocol,
      bindHost: "0.0.0.0",
      externalHost: url.hostname,
      internalHost: "127.0.0.1",
      gatewayPort: port,
      rpcPort: port,
      panelHttpPort: port,
      gitPort: port,
      workerdPort: port,
    };
  }

  // Resolve from env or CLI
  const envHost = process.env["NATSTACK_HOST"] ?? opts.host;
  const envBindHost = process.env["NATSTACK_BIND_HOST"] ?? opts.bindHost;
  const envProtocol = (process.env["NATSTACK_PROTOCOL"] ?? opts.protocol) as "http" | "https" | undefined;

  const externalHost = envHost ?? "localhost";
  const bindHost = envBindHost ?? (envHost ? "0.0.0.0" : "127.0.0.1");
  const protocol = envProtocol ?? "http";

  return {
    protocol,
    bindHost,
    externalHost,
    internalHost: "127.0.0.1",
    gatewayPort: opts.gatewayPort ?? opts.panelHttpPort,
    rpcPort: opts.rpcPort,
    panelHttpPort: opts.panelHttpPort,
    gitPort: opts.gitPort,
    workerdPort: opts.workerdPort,
    tlsCert: opts.tlsCert,
    tlsKey: opts.tlsKey,
  };
}
