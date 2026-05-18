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
      const totalBytes = 32 * 1024 * 1024;
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

  describe("getRange", () => {
    async function putViaRpc(digest: string, body: string): Promise<void> {
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = new ServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      const result = (await dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "putText",
        [body]
      )) as { digest: string };
      expect(result.digest).toBe(digest);
    }

    function dispatchGetRange(digest: string, offset: number, length: number): Promise<unknown> {
      const service = createBlobstoreService({ blobsDir });
      const dispatcher = new ServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      return dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "getRange",
        [digest, offset, length]
      );
    }

    it("returns a partial slice of a stored blob", async () => {
      const body = "The quick brown fox jumps over the lazy dog.";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);

      await expect(dispatchGetRange(digest, 4, 5)).resolves.toBe("quick");
      await expect(dispatchGetRange(digest, 0, 3)).resolves.toBe("The");
    });

    it("truncates at EOF when length overruns the blob", async () => {
      const body = "short text";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);

      await expect(dispatchGetRange(digest, 6, 999)).resolves.toBe("text");
    });

    it("returns an empty string when offset is past EOF", async () => {
      const body = "tiny";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);

      await expect(dispatchGetRange(digest, 100, 50)).resolves.toBe("");
    });

    it("returns null when the digest is unknown", async () => {
      const unknown = "0".repeat(64);
      await expect(dispatchGetRange(unknown, 0, 10)).resolves.toBeNull();
    });

    it("rejects oversized reads to bound memory", async () => {
      const body = "x";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);
      // 1 MiB > the 256 KiB hard cap.
      await expect(dispatchGetRange(digest, 0, 1024 * 1024)).rejects.toThrow(/too large/);
    });

    it("getRangeBytes returns base64-encoded raw bytes", async () => {
      // PNG magic header — non-text bytes that would mangle through
      // the UTF-8 getRange path.
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const digest = createHash("sha256").update(bytes).digest("hex");
      // Stage the binary blob via putBase64 (putText would re-encode
      // as UTF-8 and corrupt the bytes).
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = new ServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      await dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "putBase64",
        [bytes.toString("base64")]
      );
      const result = (await dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "getRangeBytes",
        [digest, 0, 8]
      )) as { bytesBase64: string };
      const decoded = Buffer.from(result.bytesBase64, "base64");
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });
  });

  describe("grep", () => {
    async function putViaRpc(body: string): Promise<string> {
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = new ServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      const result = (await dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "putText",
        [body]
      )) as { digest: string };
      return result.digest;
    }

    function dispatchGrep(
      digest: string,
      pattern: string,
      opts?: { caseInsensitive?: boolean; contextLines?: number; maxMatches?: number }
    ): Promise<unknown> {
      const service = createBlobstoreService({ blobsDir });
      const dispatcher = new ServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      return dispatcher.dispatch(
        { callerId: "w1", callerKind: "worker" },
        "blobstore",
        "grep",
        opts === undefined ? [digest, pattern] : [digest, pattern, opts]
      );
    }

    it("returns matching lines with line numbers", async () => {
      const body = ["alpha one", "beta two", "gamma three", "alpha four"].join("\n");
      const digest = await putViaRpc(body);
      const matches = (await dispatchGrep(digest, "alpha")) as Array<{
        lineNumber: number;
        line: string;
      }>;
      expect(matches.map((m) => m.lineNumber)).toEqual([1, 4]);
      expect(matches[0]!.line).toBe("alpha one");
    });

    it("honours caseInsensitive and contextLines", async () => {
      const body = ["one", "two ALPHA two", "three", "four"].join("\n");
      const digest = await putViaRpc(body);
      const matches = (await dispatchGrep(digest, "alpha", {
        caseInsensitive: true,
        contextLines: 1,
      })) as Array<{ lineNumber: number; before: string[]; after: string[] }>;
      expect(matches).toHaveLength(1);
      expect(matches[0]!.lineNumber).toBe(2);
      expect(matches[0]!.before).toEqual(["one"]);
      expect(matches[0]!.after).toEqual(["three"]);
    });

    it("caps results with maxMatches", async () => {
      const body = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join("\n");
      const digest = await putViaRpc(body);
      const matches = (await dispatchGrep(digest, "match", { maxMatches: 5 })) as unknown[];
      expect(matches).toHaveLength(5);
    });

    it("returns null when the digest is unknown", async () => {
      const unknown = "0".repeat(64);
      await expect(dispatchGrep(unknown, "anything")).resolves.toBeNull();
    });

    it("rejects malformed regex patterns", async () => {
      const digest = await putViaRpc("anything");
      await expect(dispatchGrep(digest, "([")).rejects.toThrow(/Invalid regex/);
    });

    it("rejects nested-quantifier patterns (ReDoS guard)", async () => {
      // `(a+)+b` against `aaaa…c` is the classic exponential
      // backtrack — without the guard, this freezes the server.
      const digest = await putViaRpc("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa c");
      await expect(dispatchGrep(digest, "(a+)+b")).rejects.toThrow(/nested quantifiers/);
    });

    it("rejects quantified-alternation patterns (ReDoS guard)", async () => {
      const digest = await putViaRpc("aaaa");
      await expect(dispatchGrep(digest, "(a|a)*")).rejects.toThrow(/quantified alternation/);
    });

    it("rejects oversized patterns", async () => {
      const digest = await putViaRpc("hello");
      const huge = "a".repeat(2000);
      await expect(dispatchGrep(digest, huge)).rejects.toThrow(/pattern too long/);
    });
  });
});
