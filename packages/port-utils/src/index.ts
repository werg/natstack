import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Default port ranges for different services.
 * Using ephemeral port range (49152-65535) to avoid conflicts.
 */
export const PORT_RANGES = {
  git: { start: 49152, end: 49252 },
  cdp: { start: 49252, end: 49352 },
  rpc: { start: 49352, end: 49452 },
  pubsub: { start: 49452, end: 49552 },
  workerd: { start: 49552, end: 49652 },
} as const;

const leases = new Map<string, number>();

function leaseKey(service: keyof typeof PORT_RANGES, port: number): string {
  return `${service}:${port}`;
}

function lockDir(): string {
  return process.env["NATSTACK_PORT_LOCK_DIR"] ?? path.join(os.tmpdir(), "natstack-port-locks");
}

function lockPath(service: keyof typeof PORT_RANGES, port: number): string {
  return path.join(lockDir(), `${service}-${port}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function removeStaleLock(filePath: string): void {
  try {
    const pid = Number(fs.readFileSync(filePath, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0 && processIsAlive(pid)) return;
  } catch {
    // Unreadable lock files are treated as stale; the subsequent exclusive
    // open still arbitrates races with another process doing the same cleanup.
  }
  try { fs.unlinkSync(filePath); } catch {}
}

function tryLeasePort(service: keyof typeof PORT_RANGES, port: number): number | null {
  const key = leaseKey(service, port);
  if (leases.has(key)) return null;
  fs.mkdirSync(lockDir(), { recursive: true });
  const filePath = lockPath(service, port);
  try {
    const fd = fs.openSync(filePath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
    leases.set(key, fd);
    return fd;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      removeStaleLock(filePath);
      try {
        const fd = fs.openSync(filePath, "wx");
        fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
        leases.set(key, fd);
        return fd;
      } catch {
        return null;
      }
    }
    throw err;
  }
}

export function releaseServicePort(
  service: keyof typeof PORT_RANGES,
  port: number,
): void {
  const key = leaseKey(service, port);
  const fd = leases.get(key);
  if (fd === undefined) return;
  leases.delete(key);
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath(service, port)); } catch {}
}

/**
 * Probe whether a port is available on a specific host by binding a temp server.
 * IMPORTANT: Always specify the same host the real server will use (default: 127.0.0.1)
 * to avoid IPv4/IPv6 mismatch — probing on :: can succeed while 127.0.0.1 is taken.
 */
function probePort(
  port: number,
  host: string
): Promise<{ server: net.Server } | { error: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => resolve({ error: err }));
    server.once("listening", () => resolve({ server }));
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
  let lastError: NodeJS.ErrnoException | null = null;

  for (let port = start; port < end; port++) {
    const lease = tryLeasePort(service, port);
    if (lease === null) continue;
    const result = await probePort(port, host);
    if ("server" in result) {
      await new Promise<void>((resolve) => result.server.close(() => resolve()));
      return port;
    }
    releaseServicePort(service, port);
    // EADDRINUSE is expected (port taken), anything else is a system problem
    if (result.error.code !== "EADDRINUSE") {
      throw new Error(
        `Cannot probe port ${port} for ${service}: ${result.error.code} - ${result.error.message}`
      );
    }
    lastError = result.error;
  }

  throw new Error(
    `No available port in ${service} range ${start}-${end - 1} (last error: ${lastError?.code})`
  );
}
