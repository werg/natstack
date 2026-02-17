import type { Server as HttpServer } from "http";

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
 * Listen an existing HTTP server on an available port in a service's range.
 * No TOCTOU: the actual server is bound directly — no temp server involved.
 */
export async function listenOnServicePort(
  server: HttpServer,
  service: keyof typeof PORT_RANGES,
  host = "127.0.0.1"
): Promise<number> {
  const { start, end } = PORT_RANGES[service];
  for (let port = start; port < end; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            server.removeListener("error", onError);
            reject(err);
          } else {
            reject(err);
          }
        };
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      return port;
    } catch (err: any) {
      if (err.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error(`No available port in ${service} range ${start}-${end - 1}`);
}
