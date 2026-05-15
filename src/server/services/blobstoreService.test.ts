import { createHash } from "crypto";
import { createServer, request as httpRequest, type Server } from "http";
import { promises as fsp } from "fs";
import * as path from "path";
import * as os from "os";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { createBlobstoreService } from "./blobstoreService.js";

interface TestServer {
  server: Server;
  baseUrl: string;
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

async function startBlobstoreServer(blobsDir: string): Promise<TestServer> {
  const service = createBlobstoreService({ blobsDir });
  await service.start?.();
  const putRoute = service.routes!.find((route) => route.path === "/blob")!;
  const getRoute = service.routes!.find((route) => route.path === "/blob/:digest")!;

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    const digestMatch = /^\/blob\/([^/]+)$/.exec(pathname);

    let handled: Promise<void> | void;
    if (req.method === "PUT" && pathname === "/blob") {
      handled = Promise.resolve(putRoute.handler(req, res, {}));
    } else if (req.method === "GET" && digestMatch) {
      handled = Promise.resolve(getRoute.handler(req, res, { digest: digestMatch[1]! }));
    } else {
      res.writeHead(404);
      res.end();
      return;
    }

    void Promise.resolve(handled).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function http(method: string, url: string, body?: Buffer | Readable): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(new URL(url), { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    if (body instanceof Readable) {
      body.on("error", reject);
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}

function repeatingReadable(totalBytes: number, chunkBytes = 64 * 1024): Readable {
  const chunk = Buffer.alloc(chunkBytes, 0x61);
  let remaining = totalBytes;
  return Readable.from((async function* () {
    while (remaining > 0) {
      const next = Math.min(remaining, chunkBytes);
      remaining -= next;
      yield next === chunk.length ? chunk : chunk.subarray(0, next);
    }
  })());
}

function digestForRepeatedByte(byte: number, totalBytes: number, chunkBytes = 64 * 1024): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(chunkBytes, byte);
  let remaining = totalBytes;
  while (remaining > 0) {
    const next = Math.min(remaining, chunkBytes);
    hash.update(next === chunk.length ? chunk : chunk.subarray(0, next));
    remaining -= next;
  }
  return hash.digest("hex");
}

describe("blobstoreService", () => {
  let rootDir: string;
  let blobsDir: string;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "natstack-blobstore-"));
    blobsDir = path.join(rootDir, "blobs");
  });

  afterEach(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it("stores and fetches bytes by sha256 digest", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const bytes = Buffer.from("sunny gosling", "utf8");
      const expectedDigest = createHash("sha256").update(bytes).digest("hex");

      const put = await http("PUT", `${baseUrl}/blob`, bytes);
      expect(put.status).toBe(200);
      expect(JSON.parse(put.body.toString("utf8"))).toEqual({
        digest: expectedDigest,
        size: bytes.length,
      });

      const get = await http("GET", `${baseUrl}/blob/${expectedDigest}`);
      expect(get.status).toBe(200);
      expect(get.body).toEqual(bytes);
      expect(get.headers["content-length"]).toBe(String(bytes.length));
      expect(get.headers["etag"]).toBe(`"${expectedDigest}"`);
      expect(get.headers["cache-control"]).toBe("max-age=31536000, immutable");
    } finally {
      await stopServer(server);
    }
  });

  it("deduplicates repeated PUTs and leaves no temp files", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const bytes = Buffer.from("same content", "utf8");
      const first = JSON.parse((await http("PUT", `${baseUrl}/blob`, bytes)).body.toString("utf8"));
      const second = JSON.parse((await http("PUT", `${baseUrl}/blob`, bytes)).body.toString("utf8"));

      expect(second).toEqual(first);
      await expect(fsp.readdir(path.join(blobsDir, "tmp"))).resolves.toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it("returns 404 for unknown digests and 400 for malformed digests", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const unknown = "0".repeat(64);
      expect((await http("GET", `${baseUrl}/blob/${unknown}`)).status).toBe(404);
      expect((await http("GET", `${baseUrl}/blob/not-a-digest`)).status).toBe(400);
    } finally {
      await stopServer(server);
    }
  });

  it("streams large PUT bodies without retaining them in memory", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const totalBytes = 200 * 1024 * 1024;
      const put = await http("PUT", `${baseUrl}/blob`, repeatingReadable(totalBytes));
      const body = JSON.parse(put.body.toString("utf8"));

      expect(put.status).toBe(200);
      expect(body).toEqual({
        digest: digestForRepeatedByte(0x61, totalBytes),
        size: totalBytes,
      });
    } finally {
      await stopServer(server);
    }
  }, 15_000);

  it("exposes metadata RPC, shell/server delete and list, and denies panel deletion", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    const service = createBlobstoreService({ blobsDir });
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(service.definition);
    dispatcher.markInitialized();

    try {
      const bytes = Buffer.from("rpc bytes", "utf8");
      const put = JSON.parse((await http("PUT", `${baseUrl}/blob`, bytes)).body.toString("utf8"));
      const digest = put.digest as string;

      await expect(dispatcher.dispatch(
        { callerId: "p1", callerKind: "panel" },
        "blobstore",
        "delete",
        [digest],
      )).rejects.toMatchObject({ code: "EACCES" });

      await expect(dispatcher.dispatch(
        { callerId: "p1", callerKind: "panel" },
        "blobstore",
        "has",
        [digest],
      )).resolves.toBe(true);

      const stat = await dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "stat",
        [digest],
      );
      expect(stat).toMatchObject({ size: bytes.length });

      await expect(dispatcher.dispatch(
        { callerId: "shell", callerKind: "shell" },
        "blobstore",
        "list",
        [],
      )).resolves.toContain(digest);

      await expect(dispatcher.dispatch(
        { callerId: "shell", callerKind: "shell" },
        "blobstore",
        "list",
        [{ prefix: digest.slice(0, 8), limit: 10 }],
      )).resolves.toEqual([digest]);

      await expect(dispatcher.dispatch(
        { callerId: "shell", callerKind: "shell" },
        "blobstore",
        "pruneUnreferenced",
        [{ referenced: [digest], dryRun: true }],
      )).resolves.toMatchObject({ deleted: [], dryRun: true });

      await expect(dispatcher.dispatch(
        { callerId: "server", callerKind: "server" },
        "blobstore",
        "delete",
        [digest],
      )).resolves.toBe(true);
      await expect(dispatcher.dispatch(
        { callerId: "server", callerKind: "server" },
        "blobstore",
        "has",
        [digest],
      )).resolves.toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it("sweeps stale temp files on startup", async () => {
    const tmpDir = path.join(blobsDir, "tmp");
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(path.join(tmpDir, "stale.tmp"), "partial");

    const service = createBlobstoreService({ blobsDir });

    await expect(fsp.readdir(tmpDir)).resolves.toEqual(["stale.tmp"]);
    await service.start?.();

    await expect(fsp.readdir(tmpDir)).resolves.toEqual([]);
  });
});
