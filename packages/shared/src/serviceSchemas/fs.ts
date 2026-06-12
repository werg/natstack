/**
 * fs service method schemas — per-context filesystem operations, sandboxed to
 * the caller's context folder. Pure-data wire contract shared by the server
 * registration and typed clients.
 *
 * Caller-kind argument conventions (handled inside FsService):
 * - panel/app/worker/do callers: context resolved from the EntityCache.
 * - extension callers: chained caller context (or explicit host-fs capability).
 * - server/shell/harness callers: explicit contextId as the first argument.
 *
 * `symlink` and `chown` are deliberately absent (audit findings #38/#39):
 * they are sandbox-escape primitives and nothing on the service surface
 * needs them.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const fsBinaryEnvelopeSchema = z.object({
  __bin: z.literal(true),
  data: z.string(),
});

export type FsBinaryEnvelope = z.infer<typeof fsBinaryEnvelopeSchema>;

const fsDataSchema = z.union([z.string(), fsBinaryEnvelopeSchema]);
const voidSchema = z.void();
const statSchema = z.object({
  isFile: z.boolean(),
  isDirectory: z.boolean(),
  isSymbolicLink: z.boolean(),
  size: z.number(),
  mtime: z.string(),
  ctime: z.string(),
  mode: z.number(),
});
const direntSchema = z.object({
  name: z.string(),
  _isFile: z.boolean(),
  _isDirectory: z.boolean(),
  _isSymbolicLink: z.boolean(),
});
const grepOptionsSchema = z.object({
  path: z.string().optional(),
  glob: z.string().optional(),
  caseInsensitive: z.boolean().optional(),
  contextLines: z.number().optional(),
  maxMatches: z.number().optional(),
});
const grepResultSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      lineNumber: z.number(),
      line: z.string(),
      before: z.array(z.string()),
      after: z.array(z.string()),
    })
  ),
  matchCount: z.number(),
  truncated: z.boolean(),
});
const globOptionsSchema = z.object({
  path: z.string().optional(),
});
const readdirOptionsSchema = z.object({
  withFileTypes: z.boolean().optional(),
  recursive: z.boolean().optional(),
});
const mkdirOptionsSchema = z.object({
  recursive: z.boolean().optional(),
});
const rmOptionsSchema = z.object({
  recursive: z.boolean().optional(),
  force: z.boolean().optional(),
});

export type FsStatWire = z.infer<typeof statSchema>;
export type FsDirentWire = z.infer<typeof direntSchema>;
export type FsGrepResult = z.infer<typeof grepResultSchema>;

export const fsMethods = defineServiceMethods({
  // File content
  readFile: {
    args: z.union([
      z.tuple([z.string(), z.string().optional()]),
      z.tuple([z.string(), z.string(), z.string().optional()]),
    ]),
    returns: z.union([z.string(), fsBinaryEnvelopeSchema]),
  },
  writeFile: {
    args: z.union([
      z.tuple([z.string(), fsDataSchema]),
      z.tuple([z.string(), z.string(), fsDataSchema]),
    ]),
    returns: voidSchema,
  },
  appendFile: {
    args: z.union([
      z.tuple([z.string(), fsDataSchema]),
      z.tuple([z.string(), z.string(), fsDataSchema]),
    ]),
    returns: voidSchema,
  },
  // Directories
  readdir: {
    args: z.union([
      z.tuple([z.string(), readdirOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), readdirOptionsSchema.optional()]),
    ]),
    returns: z.union([z.array(z.string()), z.array(direntSchema)]),
  },
  mkdir: {
    args: z.union([
      z.tuple([z.string(), mkdirOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), mkdirOptionsSchema.optional()]),
    ]),
    returns: z.string().optional(),
  },
  rmdir: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: voidSchema,
  },
  rm: {
    args: z.union([
      z.tuple([z.string(), rmOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), rmOptionsSchema.optional()]),
    ]),
    returns: voidSchema,
  },
  // Stat / metadata
  stat: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: statSchema,
  },
  lstat: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: statSchema,
  },
  exists: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.boolean(),
  },
  access: {
    args: z.union([
      z.tuple([z.string(), z.number().optional()]),
      z.tuple([z.string(), z.string(), z.number().optional()]),
    ]),
    returns: voidSchema,
  },
  // File manipulation
  unlink: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: voidSchema,
  },
  copyFile: {
    args: z.union([z.tuple([z.string(), z.string()]), z.tuple([z.string(), z.string(), z.string()])]),
    returns: voidSchema,
  },
  rename: {
    args: z.union([z.tuple([z.string(), z.string()]), z.tuple([z.string(), z.string(), z.string()])]),
    returns: voidSchema,
  },
  realpath: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.string(),
  },
  truncate: {
    args: z.union([
      z.tuple([z.string(), z.number().optional()]),
      z.tuple([z.string(), z.string(), z.number().optional()]),
    ]),
    returns: voidSchema,
  },
  readlink: {
    args: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.string()])]),
    returns: z.string(),
  },
  chmod: {
    args: z.union([z.tuple([z.string(), z.number()]), z.tuple([z.string(), z.string(), z.number()])]),
    returns: voidSchema,
  },
  utimes: {
    args: z.union([
      z.tuple([z.string(), z.number(), z.number()]),
      z.tuple([z.string(), z.string(), z.number(), z.number()]),
    ]),
    returns: voidSchema,
  },
  // Search
  grep: {
    args: z.union([
      z.tuple([z.string(), grepOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), grepOptionsSchema.optional()]),
    ]),
    returns: grepResultSchema,
  },
  glob: {
    args: z.union([
      z.tuple([z.string(), globOptionsSchema.optional()]),
      z.tuple([z.string(), z.string(), globOptionsSchema.optional()]),
    ]),
    returns: z.array(z.string()),
  },
  // File handles
  open: {
    args: z.union([
      z.tuple([z.string(), z.string().optional(), z.number().optional()]),
      z.tuple([z.string(), z.string(), z.string().optional(), z.number().optional()]),
    ]),
    returns: z.object({ handleId: z.number() }),
  },
  handleRead: {
    args: z.union([
      z.tuple([z.number(), z.number(), z.number().nullable()]),
      z.tuple([z.string(), z.number(), z.number(), z.number().nullable()]),
    ]),
    returns: z.object({ bytesRead: z.number(), buffer: fsBinaryEnvelopeSchema }),
  },
  handleWrite: {
    args: z.union([
      z.tuple([z.number(), fsDataSchema, z.number().nullable()]),
      z.tuple([z.string(), z.number(), fsDataSchema, z.number().nullable()]),
    ]),
    returns: z.object({ bytesWritten: z.number() }),
  },
  handleClose: {
    args: z.union([z.tuple([z.number()]), z.tuple([z.string(), z.number()])]),
    returns: voidSchema,
  },
  handleStat: {
    args: z.union([z.tuple([z.number()]), z.tuple([z.string(), z.number()])]),
    returns: statSchema,
  },
  // Tmp files
  mktemp: {
    args: z.union([z.tuple([z.string().optional()]), z.tuple([z.string(), z.string().optional()])]),
    returns: z.string(),
  },
});
