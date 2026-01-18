import * as net from "net";

/**
 * Default port ranges for different services.
 * Using ephemeral port range (49152-65535) to avoid conflicts.
 */
export const PORT_RANGES = {
  git: { start: 49152, end: 49252 },
  cdp: { start: 49252, end: 49352 },
  pubsub: { start: 49452, end: 49552 },
  verdaccio: { start: 49552, end: 49652 },
} as const;

/**
 * Try to bind to a port and return the server if successful.
 * This avoids TOCTOU race conditions by returning the bound server directly.
 */
export function tryBindPort(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.once("listening", () => resolve(server));
    server.listen(port);
  });
}

/**
 * Find an available port within a range and return the bound server.
 * This eliminates TOCTOU by keeping the server bound until the caller is ready.
 * @param startPort - First port to try
 * @param endPort - Last port to try (exclusive)
 * @returns Object with port number and the bound server (caller must close it before using the port)
 * @throws Error if no port is available in the range
 */
export async function findAndBindPort(
  startPort: number,
  endPort?: number
): Promise<{ port: number; server: net.Server }> {
  const maxPort = endPort ?? startPort + 100;
  for (let port = startPort; port < maxPort; port++) {
    const server = await tryBindPort(port);
    if (server) {
      return { port, server };
    }
  }
  throw new Error(`No available port in range ${startPort}-${maxPort - 1}`);
}

/**
 * Find an available port for a specific service and return the bound server.
 * Caller must close the returned server before binding their own server to the port.
 * @param service - Service name from PORT_RANGES
 * @returns Object with port number and temporary server holding the port
 */
export async function findAvailablePortForService(
  service: keyof typeof PORT_RANGES
): Promise<{ port: number; server: net.Server }> {
  const range = PORT_RANGES[service];
  return findAndBindPort(range.start, range.end);
}
