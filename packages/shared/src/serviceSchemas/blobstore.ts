/**
 * blobstore service method schemas — per-workspace content-addressable blob
 * storage. Pure-data wire contract shared by the server registration and
 * typed clients.
 */

import { z } from "zod";
import type { ServicePolicy, MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const PREFIX_RE = /^[0-9a-f]{0,64}$/;

export const BLOBSTORE_READ_POLICY: ServicePolicy = {
  allowed: ["panel", "app", "worker", "do", "shell", "server"],
};
export const BLOBSTORE_ADMIN_POLICY: ServicePolicy = { allowed: ["shell", "server"] };

// Access descriptors shared across the read/write/admin method groups. Caller-kind
// policy remains declared on `policy`; these descriptors carry sensitivity metadata
// for docs and read-only enforcement.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const ADMIN_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const ADMIN_DESTRUCTIVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

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
  has: {
    description: "Whether a blob with this content digest exists in the workspace store.",
    args: z.tuple([DigestSchema]),
    returns: z.boolean(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
    examples: [
      {
        args: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        returns: false,
      },
    ],
  },
  stat: {
    description: "Size (bytes) and last-modified time of a blob, or null if it does not exist.",
    args: z.tuple([DigestSchema]),
    returns: z.object({ size: z.number(), mtime: z.number() }).nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  putText: {
    description:
      "Store a UTF-8 string; returns its content digest + byte size. Content-addressed, so identical text always yields the same digest (idempotent).",
    args: z.tuple([z.string()]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    policy: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
    examples: [{ args: ["hello world"] }],
  },
  getText: {
    description: "Full UTF-8 text of a blob, or null if absent.",
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  getRange: {
    description:
      "UTF-8 text slice. offset/length are BYTES (so they compose with stat.size); the returned string is UTF-8-decoded, so partial codepoints at slice boundaries become U+FFFD replacement chars. Use getRangeBytes for a raw binary slice.",
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  getRangeBytes: {
    description:
      "Raw byte slice, base64-encoded on the wire so binary blobs (PDFs, images) round-trip intact. Decode with Buffer.from(result.bytesBase64, 'base64').",
    args: z.tuple([DigestSchema, z.number().int().nonnegative(), z.number().int().positive()]),
    returns: z.object({ bytesBase64: z.string() }).nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  grep: {
    description:
      "Search a blob's text for a regex pattern; returns matching lines with optional surrounding context, or null if the blob is absent.",
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
    access: READ_ACCESS,
  },
  putBase64: {
    description:
      "Store raw bytes from a base64 payload; returns content digest + byte size (idempotent by content).",
    args: z.tuple([Base64Schema]),
    returns: z.object({ digest: z.string(), size: z.number() }),
    policy: BLOBSTORE_READ_POLICY,
    access: WRITE_ACCESS,
  },
  getBase64: {
    description: "Full blob contents as a base64 string, or null if absent.",
    args: z.tuple([DigestSchema]),
    returns: z.string().nullable(),
    policy: BLOBSTORE_READ_POLICY,
    access: READ_ACCESS,
  },
  delete: {
    description: "Delete a blob by digest; returns true if it existed. Destructive, admin-only.",
    args: z.tuple([DigestSchema]),
    returns: z.boolean(),
    policy: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_DESTRUCTIVE_ACCESS,
  },
  list: {
    description:
      "List blob digests, optionally filtered by hex prefix and capped by limit. Admin-only.",
    args: ListArgsSchema,
    returns: z.array(z.string()),
    policy: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_READ_ACCESS,
  },
  pruneUnreferenced: {
    description:
      "Garbage-collect blobs not in the `referenced` set (optionally only those older than olderThanMs). Pass dryRun:true to preview without deleting. Destructive, admin-only.",
    args: z.tuple([PruneOptsSchema]),
    returns: z.object({ deleted: z.array(z.string()), kept: z.number(), dryRun: z.boolean() }),
    policy: BLOBSTORE_ADMIN_POLICY,
    access: ADMIN_DESTRUCTIVE_ACCESS,
    examples: [{ args: [{ referenced: [], dryRun: true }] }],
  },
});
