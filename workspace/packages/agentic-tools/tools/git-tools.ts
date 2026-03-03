/**
 * Git tools for pubsub RPC.
 *
 * Implements: git (status, diff, commit, log, push)
 * Delegates to the main process git context service via RPC.
 */

import type { MethodDefinition } from "@workspace/agentic-messaging";
import {
  GitArgsSchema,
  type GitArgs,
} from "@workspace/agentic-messaging/tool-schemas";
import { rpc, contextId } from "@workspace/runtime";

/**
 * git - Execute git operations via main process RPC
 */
export async function gitOp(args: GitArgs): Promise<string> {
  const result = await rpc.call<string>(
    "main",
    "git.contextOp",
    contextId,
    args.operation,
    args.path,
    args.message,
    args.files,
  );
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/**
 * Create method definitions for git tools.
 */
export function createGitToolMethodDefinitions(): Record<string, MethodDefinition> {
  return {
    git: {
      description:
        "Git operations on the workspace. Supports: status (show changed files), " +
        "diff (show changes), commit (stage and commit with message), " +
        "log (show recent commits), push (push to origin, triggers auto-build).",
      parameters: GitArgsSchema,
      execute: gitOp,
    },
  };
}
