/**
 * NatStack Approval Gate Extension
 *
 * Pi extension that gates tool execution by an approval level. The level is
 * read lazily via a closure-bound getter so the worker can change it at any
 * time without re-registering the extension.
 *
 * Levels:
 *   0 — Ask all (every tool call gets a UI confirm prompt)
 *   1 — Auto safe (safe tools auto-approved, others get a prompt)
 *   2 — Full auto (everything runs without prompts)
 */

import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

export type ApprovalLevel = 0 | 1 | 2;

export interface ApprovalGateDeps {
  /** Read lazily on every tool_call event so the worker can mutate the level mid-conversation. */
  getApprovalLevel: () => ApprovalLevel;
  /** Tool names that auto-approve at level 1. */
  safeToolNames: ReadonlySet<string>;
}

/** Pi built-in tools that are typically considered "safe" (read-only). */
export const DEFAULT_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "find",
]);

export function createApprovalGateExtension(
  deps: ApprovalGateDeps,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      const level = deps.getApprovalLevel();

      if (level === 2) return undefined; // full auto
      if (level === 1 && deps.safeToolNames.has(event.toolName)) return undefined;

      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `Tool "${event.toolName}" requires approval but no UI is bound (headless)`,
        };
      }

      const argsPreview = JSON.stringify(event.input ?? {}).slice(0, 200);
      const allowed = await ctx.ui.confirm(
        "Allow tool call?",
        `Tool: ${event.toolName}\nArgs: ${argsPreview}`,
      );

      return allowed ? undefined : { block: true, reason: "User denied tool call" };
    });
  };
}
