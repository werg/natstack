/**
 * fs service definition — per-context filesystem operations, sandboxed to the
 * caller's context folder. The implementation lives in
 * `@natstack/shared/fsService` (FsService); this module declares the RPC
 * surface (method schemas + policy) for dispatcher registration.
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

import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { handleFsCall, type FsService } from "@natstack/shared/fsService";
import { fsMethods } from "@natstack/shared/serviceSchemas/fs";

export function createFsServiceDefinition(getFsService: () => FsService): ServiceDefinition {
  return {
    name: "fs",
    description: "Per-context filesystem operations (sandboxed to context folder)",
    policy: {
      allowed: ["panel", "app", "server", "worker", "do", "extension", "shell", "harness"],
    },
    methods: fsMethods,
    handler: (ctx, method, serviceArgs) => handleFsCall(getFsService(), ctx, method, serviceArgs),
  };
}
