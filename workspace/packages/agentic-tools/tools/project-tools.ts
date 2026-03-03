/**
 * Project scaffolding tools for pubsub RPC.
 *
 * Implements: create_project
 * Delegates to the main process project service via RPC.
 */

import type { MethodDefinition } from "@workspace/agentic-messaging";
import {
  CreateProjectArgsSchema,
  type CreateProjectArgs,
} from "@workspace/agentic-messaging/tool-schemas";
import { rpc, contextId } from "@workspace/runtime";

interface CreateProjectResult {
  created: string;
  type: string;
  name: string;
  title: string;
  files: string[];
}

/**
 * create_project - Scaffold a new workspace project via main process RPC
 */
export async function createProject(args: CreateProjectArgs): Promise<string> {
  const result = await rpc.call<CreateProjectResult>(
    "main",
    "project.create",
    contextId,
    args.type,
    args.name,
    args.title,
  );

  return (
    `Created ${result.type} "${result.title}" at ${result.created}\n` +
    `Files: ${result.files.join(", ")}`
  );
}

/**
 * Create method definitions for project tools.
 */
export function createProjectToolMethodDefinitions(): Record<string, MethodDefinition> {
  return {
    create_project: {
      description:
        "Scaffold a new workspace project with boilerplate files. " +
        "Supports types: panel (React app), package (reusable library), " +
        "skill (documentation/prompts), agent (background worker). " +
        "Automatically initializes git and pushes to trigger auto-build.",
      parameters: CreateProjectArgsSchema,
      execute: createProject,
    },
  };
}
