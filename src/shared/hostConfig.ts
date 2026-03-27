/**
 * HostConfig — resolved host/port configuration for a NatStack server.
 *
 * Abstracts away whether panels are served on localhost (Electron local)
 * or on a remote host (remote server mode). All URL construction flows
 * through this config.
 */

export interface HostConfig {
  /** The hostname panels are served on (e.g., "localhost", "my-server.example.com") */
  externalHost: string;
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
}

/**
 * Resolve host config from environment or explicit values.
 *
 * In local mode: all services run on localhost with separate ports.
 * In remote mode: gateway multiplexes everything on a single port/host.
 */
export function resolveHostConfig(opts: {
  remoteUrl?: string;
  rpcPort: number;
  panelHttpPort: number;
  gitPort: number;
  workerdPort: number;
  gatewayPort?: number;
}): HostConfig {
  if (opts.remoteUrl) {
    const url = new URL(opts.remoteUrl);
    const port = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);
    return {
      externalHost: url.hostname,
      gatewayPort: port,
      rpcPort: port,
      panelHttpPort: port,
      gitPort: port,
      workerdPort: port,
    };
  }

  return {
    externalHost: "localhost",
    gatewayPort: opts.gatewayPort ?? opts.panelHttpPort,
    rpcPort: opts.rpcPort,
    panelHttpPort: opts.panelHttpPort,
    gitPort: opts.gitPort,
    workerdPort: opts.workerdPort,
  };
}
