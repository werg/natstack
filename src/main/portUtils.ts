import * as net from "net";

/**
 * Default port ranges for different services.
 * Using ephemeral port range (49152-65535) to avoid conflicts.
 */
export const PORT_RANGES = {
  git: { start: 49152, end: 49252 },
  cdp: { start: 49252, end: 49352 },
  rpc: { start: 49352, end: 49452 },
  pubsub: { start: 49452, end: 49552 },
} as const;

/**
 * Probe whether a port is available on a specific host by binding a temp server.
 * IMPORTANT: Always specify the same host the real server will use (default: 127.0.0.1)
 * to avoid IPv4/IPv6 mismatch — probing on :: can succeed while 127.0.0.1 is taken.
 */
function probePort(port: number, host: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.once("listening", () => resolve(server));
    server.listen(port, host);
  });
}

/**
 * Find an available port for a service. Returns the port number.
 * Probes with a temp server on the correct host, closes it, then returns.
 * Callers should bind their real server immediately after.
 */
export async function findServicePort(
  service: keyof typeof PORT_RANGES,
  host = "127.0.0.1"
): Promise<number> {
  const { start, end } = PORT_RANGES[service];
  for (let port = start; port < end; port++) {
    const server = await probePort(port, host);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }
  }
  throw new Error(`No available port in ${service} range ${start}-${end - 1}`);
}
