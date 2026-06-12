/**
 * blobstore service method schemas — per-workspace content-addressable blob
 * storage. Pure-data wire contract shared by the server registration and
 * typed clients.
 */

import { z } from "zod";
import type { ServicePolicy } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const PREFIX_RE = /^[0-9a-f]{0,64}$/;

export const BLOBSTORE_READ_POLICY: ServicePolicy = {
  allowed: ["panel", "app", "worker", "do", "shell", "server"],
};
export const BLOBSTORE_ADMIN_POLICY: ServicePolicy = { allowed: ["shell", "server"] };

export const DigestSchema = z.string().regex(DIGEST_RE);
export const Base64Schema = z.string().refine((value) => {
  try {
    return (
      Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "") ===
      value.replace(/=+$/u, "")
    );
  } catch {
    return false;
  }
}, "Invalid base64 payload");
export const ListOptsSchema = z
  .object({
    prefix: z.string().regex(PREFIX_RE).optional(),
    limit: z.number().int().positive().max(100_000).optional(),
  })
  .optional();
export const PruneOptsSchema = z.object({
  referenced: z.array(DigestSchema),
  dryRun: z.boolean().optional(),
  olderThanMs: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(100_000).optional(),
});
export const ListArgsSchema = z.union([z.tuple([]), z.tuple([ListOptsSchema])]);

export const blobstoreMethods = defineServiceMethods({
  has: { args: z.tuple([DigestSchema]), returns: z.boolean(), policy: BLOBSTORE_READ_POLICY },
  stat: {
    args: z.tuple([DigestSchema]),
    returns: z.object({ size: z.number(), mtime: z.number() }).nullable(),
    policy: BLOBSTORE_READ_POLICY,
  },
  putText: {
    args: z.tuple([z.string()]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    policy: BLOBSTORE_READ_POLICY,
  },
  getText: {
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
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
    policy: BLOBSTORE_READ_POLICY,
  },
  /**
   * Raw byte slice — base64-encoded on the wire so binary blobs
   * (PDFs, images) round-trip intact. Caller decodes with
   * `Buffer.from(result.bytesBase64, "base64")` (or equivalent).
   */
  getRangeBytes: {
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.object({ bytesBase64: z.string() }).nullable(),
    policy: BLOBSTORE_READ_POLICY,
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
    policy: BLOBSTORE_READ_POLICY,
  },
  putBase64: {
    args: z.tuple([Base64Schema]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    policy: BLOBSTORE_READ_POLICY,
  },
  getBase64: {
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
  },
  delete: { args: z.tuple([DigestSchema]), returns: z.boolean(), policy: BLOBSTORE_ADMIN_POLICY },
  list: { args: ListArgsSchema, returns: z.array(z.string()), policy: BLOBSTORE_ADMIN_POLICY },
  pruneUnreferenced: {
    args: z.tuple([PruneOptsSchema]),
    returns: z.object({ deleted: z.array(z.string()), kept: z.number(), dryRun: z.boolean() }),
    policy: BLOBSTORE_ADMIN_POLICY,
  },
});
