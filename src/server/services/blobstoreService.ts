import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import { promises as fsp } from "fs";
import * as path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import { createDevLogger } from "@natstack/dev-log";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServicePolicy } from "@natstack/shared/servicePolicy";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../rpcServiceWithRoutes.js";
import { assertPresent } from "../../lintHelpers";

const log = createDevLogger("BlobstoreService");

const DIGEST_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[0-9a-f]{0,64}$/;
const READ_POLICY: ServicePolicy = { allowed: ["panel", "worker", "do", "shell", "server"] };
const ADMIN_POLICY: ServicePolicy = { allowed: ["shell", "server"] };

const DigestSchema = z.string().regex(DIGEST_RE);
const Base64Schema = z.string().refine((value) => {
  try {
    return (
      Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "") ===
      value.replace(/=+$/u, "")
    );
  } catch {
    return false;
  }
}, "Invalid base64 payload");
const ListOptsSchema = z
  .object({
    prefix: z.string().regex(PREFIX_RE).optional(),
    limit: z.number().int().positive().max(100_000).optional(),
  })
  .optional();
const PruneOptsSchema = z.object({
  referenced: z.array(DigestSchema),
  dryRun: z.boolean().optional(),
  olderThanMs: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100_000).optional(),
});
const ListArgsSchema = z.union([z.tuple([]), z.tuple([ListOptsSchema])]);

export interface BlobstoreServiceDeps {
  blobsDir: string;
}

export interface BlobStat {
  size: number;
  mtime: number;
}

function ensureLayout(blobsDir: string): void {
  fs.mkdirSync(path.join(blobsDir, "tmp"), { recursive: true });
  fs.mkdirSync(path.join(blobsDir, "sha256"), { recursive: true });
}

function sweepTmp(blobsDir: string): void {
  const tmpDir = path.join(blobsDir, "tmp");
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
}

function validateDigest(digest: string): void {
  if (!DIGEST_RE.test(digest)) {
    throw new Error("Invalid sha256 digest");
  }
}

function blobPath(blobsDir: string, digest: string): string {
  validateDigest(digest);
  return path.join(blobsDir, "sha256", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function statBlob(blobsDir: string, digest: string): Promise<BlobStat | null> {
  const filePath = blobPath(blobsDir, digest);
  try {
    const stat = await fsp.stat(filePath);
    return { size: stat.size, mtime: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function putBlob(
  blobsDir: string,
  req: IncomingMessage
): Promise<{ digest: string; size: number }> {
  const tmpPath = path.join(blobsDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let size = 0;

  const tee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, tee, fs.createWriteStream(tmpPath, { flags: "wx" }));
    const digest = hash.digest("hex");
    const finalPath = blobPath(blobsDir, digest);
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fsp.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await fsp.unlink(tmpPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return { digest, size };
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function putBytes(
  blobsDir: string,
  bytes: Buffer
): Promise<{ digest: string; size: number }> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const finalPath = blobPath(blobsDir, digest);
  if (await pathExists(finalPath)) {
    return { digest, size: bytes.byteLength };
  }

  const tmpPath = path.join(blobsDir, "tmp", `${process.pid}-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(tmpPath, bytes, { flag: "wx" });
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fsp.link(tmpPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await fsp.unlink(tmpPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return { digest, size: bytes.byteLength };
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function getBytes(blobsDir: string, digest: string): Promise<Buffer | null> {
  const filePath = blobPath(blobsDir, digest);
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Hard cap on a single getRange read. A caller that wants more must
 * page — both keeps memory usage bounded per request and limits the
 * blast radius of a buggy/malicious caller that asks for `length: 1e12`.
 * 256 KiB is well above the natural ~8 KiB head excerpt that the
 * agent uses, leaving plenty of room for explicit drilling.
 */
const MAX_GET_RANGE_BYTES = 256 * 1024;

async function getByteRange(
  blobsDir: string,
  digest: string,
  offset: number,
  length: number
): Promise<Buffer | null> {
  if (length > MAX_GET_RANGE_BYTES) {
    throw new Error(
      `blobstore.getRange length too large (${length} > ${MAX_GET_RANGE_BYTES} bytes); page the request`
    );
  }
  const filePath = blobPath(blobsDir, digest);
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    if (offset >= stat.size) return Buffer.alloc(0);
    const cappedLength = Math.min(length, stat.size - offset);
    const buf = Buffer.alloc(cappedLength);
    if (cappedLength > 0) {
      await handle.read(buf, 0, cappedLength, offset);
    }
    return buf;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export interface GrepMatch {
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

/**
 * Reject regex patterns prone to catastrophic backtracking. The
 * native JS regex engine has no execution timeout, so a single
 * pathological pattern can freeze the server indefinitely once
 * `re.test()` enters exponential backtracking on adversarial input
 * (e.g. `(a+)+b` against `aaaaaaaaaaaaaaaac`).
 *
 * Defense in depth — for an absolute guarantee we'd need a
 * non-backtracking engine like RE2. This validator catches the
 * common bad shapes:
 *
 *   1. Length cap — keeps the search space bounded.
 *   2. Nested quantifiers — `(...)+` / `(...)*` / `(...){n,}` where
 *      the inner group contains its own quantifier.
 *   3. Adjacent quantifiers on overlapping classes — `a+a*` style.
 */
function assertSafeGrepPattern(pattern: string): void {
  if (pattern.length > 1024) {
    throw new Error(`grep pattern too long (max 1024 chars, got ${pattern.length})`);
  }
  // Nested quantifier inside a quantified group: `(...+...)+`,
  // `(...*...)*`, `(...{N,}...)+`, etc.
  if (/\([^)]*[+*][^)]*\)\s*[+*?{]/u.test(pattern)) {
    throw new Error(
      "grep pattern contains nested quantifiers (catastrophic-backtracking risk); rewrite to avoid `(...+...)+` or `(...*...)*` shapes"
    );
  }
  // Alternation of overlapping single-char classes inside a
  // quantifier: `(a|a)*`, `(a|ab)+`, etc. Detected loosely as a
  // group with `|` followed by a quantifier.
  if (/\([^()]*\|[^()]*\)\s*[+*]/u.test(pattern)) {
    // Allow only if the inner branches don't share a leading char —
    // hard to check without a parser. Conservative: reject.
    throw new Error(
      "grep pattern uses quantified alternation (catastrophic-backtracking risk); rewrite without `(a|b)*` style"
    );
  }
}

async function grepBlob(
  blobsDir: string,
  digest: string,
  pattern: string,
  opts: { caseInsensitive?: boolean; contextLines?: number; maxMatches?: number }
): Promise<GrepMatch[] | null> {
  const bytes = await getBytes(blobsDir, digest);
  if (!bytes) return null;
  // ReDoS mitigation — bound pattern length and reject patterns with
  // catastrophic-backtracking shapes BEFORE compilation. The native
  // regex engine has no execution timeout in JS, so a pathological
  // pattern (e.g. `(a+)+b`) would freeze the server during `re.test`.
  assertSafeGrepPattern(pattern);
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/u);
  let re: RegExp;
  try {
    re = new RegExp(pattern, opts.caseInsensitive ? "iu" : "u");
  } catch (err) {
    throw new Error(`Invalid regex: ${(err as Error).message}`);
  }
  const context = Math.max(0, Math.min(opts.contextLines ?? 0, 10));
  const maxMatches = Math.max(1, Math.min(opts.maxMatches ?? 50, 500));
  const matches: GrepMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxMatches) break;
    if (!re.test(assertPresent(lines[i]))) continue;
    const before: string[] = [];
    for (let j = Math.max(0, i - context); j < i; j++) before.push(assertPresent(lines[j]));
    const after: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + context); j++)
      after.push(assertPresent(lines[j]));
    matches.push({ lineNumber: i + 1, line: assertPresent(lines[i]), before, after });
  }
  return matches;
}

async function listBlobs(
  blobsDir: string,
  opts?: { prefix?: string; limit?: number }
): Promise<string[]> {
  const prefix = opts?.prefix ?? "";
  const limit = opts?.limit;
  const shaDir = path.join(blobsDir, "sha256");
  const results: string[] = [];

  let firstDirs: fs.Dirent[];
  try {
    firstDirs = await fsp.readdir(shaDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  for (const first of firstDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!first.isDirectory() || !/^[0-9a-f]{2}$/.test(first.name)) continue;
    if (prefix.length >= 2 && first.name !== prefix.slice(0, 2)) continue;
    if (prefix.length < 2 && !first.name.startsWith(prefix)) continue;

    const secondDirPath = path.join(shaDir, first.name);
    const secondDirs = await fsp.readdir(secondDirPath, { withFileTypes: true });
    for (const second of secondDirs.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!second.isDirectory() || !/^[0-9a-f]{2}$/.test(second.name)) continue;
      const firstFour = first.name + second.name;
      if (prefix.length >= 4 && firstFour !== prefix.slice(0, 4)) continue;
      if (prefix.length < 4 && !firstFour.startsWith(prefix)) continue;

      const leafDir = path.join(secondDirPath, second.name);
      const files = await fsp.readdir(leafDir, { withFileTypes: true });
      for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!file.isFile()) continue;
        const digest = firstFour + file.name;
        if (!DIGEST_RE.test(digest)) continue;
        if (!digest.startsWith(prefix)) continue;
        results.push(digest);
        if (limit && results.length >= limit) return results;
      }
    }
  }

  return results;
}

async function pruneUnreferencedBlobs(
  blobsDir: string,
  opts: { referenced: string[]; dryRun?: boolean; olderThanMs?: number; limit?: number }
): Promise<{ deleted: string[]; kept: number; dryRun: boolean }> {
  const referenced = new Set(opts.referenced);
  const all = await listBlobs(blobsDir, { limit: opts.limit });
  const deleted: string[] = [];
  let kept = 0;
  const now = Date.now();
  for (const digest of all) {
    if (referenced.has(digest)) {
      kept++;
      continue;
    }
    const stat = await statBlob(blobsDir, digest);
    if (!stat) continue;
    if (opts.olderThanMs != null && now - stat.mtime < opts.olderThanMs) {
      kept++;
      continue;
    }
    deleted.push(digest);
    if (!opts.dryRun) {
      await fsp.unlink(blobPath(blobsDir, digest)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
  return { deleted, kept, dryRun: opts.dryRun === true };
}

export function createBlobstoreService(deps: BlobstoreServiceDeps): ServiceWithRoutes {
  const definition: ServiceDefinition = {
    name: "blobstore",
    description: "Per-workspace content-addressable blob storage",
    policy: READ_POLICY,
    methods: {
      has: { args: z.tuple([DigestSchema]), returns: z.boolean(), policy: READ_POLICY },
      stat: {
        args: z.tuple([DigestSchema]),
        returns: z.object({ size: z.number(), mtime: z.number() }).nullable(),
        policy: READ_POLICY,
      },
      putText: {
        args: z.tuple([z.string()]),
        returns: z.object({ digest: z.string(), size: z.number() }),
        policy: READ_POLICY,
      },
      getText: {
        args: z.tuple([DigestSchema]),
        returns: z.string().nullable(),
        policy: READ_POLICY,
      },
      /**
       * UTF-8 text slice. The offset/length are bytes (so they
       * compose with `stat.size`) but the returned string is decoded
       * as UTF-8 — partial codepoints at slice boundaries become
       * U+FFFD replacement chars rather than corrupted bytes. Use
       * `getRangeBytes` if you need a raw binary slice.
       */
      getRange: {
        args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
        returns: z.string().nullable(),
        policy: READ_POLICY,
      },
      /**
       * Raw byte slice — base64-encoded on the wire so binary blobs
       * (PDFs, images) round-trip intact. Caller decodes with
       * `Buffer.from(result.bytesBase64, "base64")` (or equivalent).
       */
      getRangeBytes: {
        args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
        returns: z.object({ bytesBase64: z.string() }).nullable(),
        policy: READ_POLICY,
      },
      grep: {
        args: z.tuple([
          DigestSchema,
          z.string(),
          z
            .object({
              caseInsensitive: z.boolean().optional(),
              contextLines: z.number().int().nonnegative().max(10).optional(),
              maxMatches: z.number().int().positive().max(500).optional(),
            })
            .optional(),
        ]),
        returns: z
          .array(
            z.object({
              lineNumber: z.number(),
              line: z.string(),
              before: z.array(z.string()),
              after: z.array(z.string()),
            })
          )
          .nullable(),
        policy: READ_POLICY,
      },
      putBase64: {
        args: z.tuple([Base64Schema]),
        returns: z.object({ digest: z.string(), size: z.number() }),
        policy: READ_POLICY,
      },
      getBase64: {
        args: z.tuple([DigestSchema]),
        returns: z.string().nullable(),
        policy: READ_POLICY,
      },
      delete: { args: z.tuple([DigestSchema]), returns: z.boolean(), policy: ADMIN_POLICY },
      list: { args: ListArgsSchema, returns: z.array(z.string()), policy: ADMIN_POLICY },
      pruneUnreferenced: {
        args: z.tuple([PruneOptsSchema]),
        returns: z.object({ deleted: z.array(z.string()), kept: z.number(), dryRun: z.boolean() }),
        policy: ADMIN_POLICY,
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "has":
          return pathExists(blobPath(deps.blobsDir, args[0] as string));
        case "stat":
          return statBlob(deps.blobsDir, args[0] as string);
        case "putText":
          return putBytes(deps.blobsDir, Buffer.from(args[0] as string, "utf8"));
        case "getText": {
          const bytes = await getBytes(deps.blobsDir, args[0] as string);
          return bytes ? bytes.toString("utf8") : null;
        }
        case "getRange": {
          const bytes = await getByteRange(
            deps.blobsDir,
            args[0] as string,
            args[1] as number,
            args[2] as number
          );
          return bytes ? bytes.toString("utf8") : null;
        }
        case "getRangeBytes": {
          const bytes = await getByteRange(
            deps.blobsDir,
            args[0] as string,
            args[1] as number,
            args[2] as number
          );
          return bytes ? { bytesBase64: bytes.toString("base64") } : null;
        }
        case "grep": {
          return grepBlob(
            deps.blobsDir,
            args[0] as string,
            args[1] as string,
            (args[2] as {
              caseInsensitive?: boolean;
              contextLines?: number;
              maxMatches?: number;
            }) ?? {}
          );
        }
        case "putBase64":
          return putBytes(deps.blobsDir, Buffer.from(args[0] as string, "base64"));
        case "getBase64": {
          const bytes = await getBytes(deps.blobsDir, args[0] as string);
          return bytes ? bytes.toString("base64") : null;
        }
        case "delete": {
          const filePath = blobPath(deps.blobsDir, args[0] as string);
          try {
            await fsp.unlink(filePath);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        }
        case "list":
          return listBlobs(
            deps.blobsDir,
            args[0] as { prefix?: string; limit?: number } | undefined
          );
        case "pruneUnreferenced":
          return pruneUnreferencedBlobs(
            deps.blobsDir,
            args[0] as {
              referenced: string[];
              dryRun?: boolean;
              olderThanMs?: number;
              limit?: number;
            }
          );
        default:
          throw new Error(`Unknown blobstore method '${method}'`);
      }
    },
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: "blobstore",
      path: "/blob",
      methods: ["PUT"],
      auth: "caller-token",
      handler: async (req, res) => {
        try {
          sendJson(res, 200, await putBlob(deps.blobsDir, req));
        } catch (error) {
          log.warn("Blob PUT failed:", error);
          sendText(res, 500, "Blob write failed");
        }
      },
    },
    {
      serviceName: "blobstore",
      path: "/blob/:digest",
      methods: ["GET"],
      auth: "caller-token",
      handler: async (_req, res, params) => {
        const digest = params["digest"] ?? "";
        if (!DIGEST_RE.test(digest)) {
          sendText(res, 400, "Malformed digest");
          return;
        }

        const filePath = blobPath(deps.blobsDir, digest);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            sendText(res, 404, "Blob not found");
            return;
          }
          log.warn("Blob stat failed:", error);
          sendText(res, 500, "Blob read failed");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
          ETag: `"${digest}"`,
          "Cache-Control": "max-age=31536000, immutable",
        });
        const stream = fs.createReadStream(filePath);
        stream.on("error", (error) => {
          log.warn("Blob read stream failed:", error);
          if (!res.headersSent) {
            sendText(res, 500, "Blob read failed");
          } else {
            res.destroy(error);
          }
        });
        stream.pipe(res);
      },
    },
  ];

  return {
    definition,
    routes,
    start() {
      ensureLayout(deps.blobsDir);
      sweepTmp(deps.blobsDir);
    },
  };
}
