/**
 * Protocol parser for ns:// URLs.
 *
 * URL Format: ns:///{source}?action={navigate|child}&contextId={id}&repoArgs={json}
 *
 * Examples:
 *   ns:///panels/editor
 *   ns:///panels/editor?action=child
 *   ns:///panels/editor?repoArgs=%7B%22workspace%22%3A%22repos%2Fapp%22%7D
 */

import { z } from "zod";
import type { RepoArgSpec } from "../shared/types.js";

const RepoArgSpecSchema = z.union([
  z.string(),
  z.object({
    repo: z.string(),
    ref: z.string().optional(),
  }),
]);

const RepoArgsSchema = z.record(z.string(), RepoArgSpecSchema);

export type NsAction = "navigate" | "child";

export interface ParsedNsUrl {
  source: string;
  action: NsAction;
  /**
   * Git ref (branch/tag/commit) for the panel source.
   */
  gitRef?: string;
  /**
   * Explicit context ID for storage partition sharing.
   * If provided, the panel will use this context ID instead of generating a new one.
   * This enables multiple panels to share the same OPFS/IndexedDB partition.
   */
  contextId?: string;
  repoArgs?: Record<string, RepoArgSpec>;
  env?: Record<string, string>;
  /** State arguments for the panel (validated against manifest schema in panelManager) */
  stateArgs?: Record<string, unknown>;
  name?: string;
  /** If true, immediately focus the new panel after creation (only applies to action=child on app panels) */
  focus?: boolean;
}

/**
 * Parse an ns:// URL into its components.
 */
export function parseNsUrl(url: string): ParsedNsUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== "ns:") {
    throw new Error(`Invalid ns URL protocol: ${parsed.protocol}`);
  }

  // Format: ns:///panels/editor or ns://panels/editor
  // Note: URLs like ns://panels/editor parse "panels" as host; support both.
  const rawPath = parsed.host ? `${parsed.host}${parsed.pathname}` : parsed.pathname.replace(/^\/+/, "");
  const source = decodeURIComponent(rawPath);
  if (!source) {
    throw new Error(`Invalid ns URL: missing source path (${url})`);
  }

  // Parse action (default: navigate)
  const actionParam = parsed.searchParams.get("action");
  let action: NsAction = "navigate";
  if (actionParam === "child") {
    action = "child";
  } else if (actionParam && actionParam !== "navigate") {
    throw new Error(`Invalid ns URL action: ${actionParam} (expected "navigate" or "child")`);
  }

  const name = parsed.searchParams.get("name") ?? undefined;
  const focus = parsed.searchParams.get("focus") === "true" || undefined;

  // Parse gitRef: branch/tag/commit for the panel source
  const gitRef = parsed.searchParams.get("gitRef") ?? undefined;

  // Parse contextId: explicit context ID for partition sharing
  const contextId = parsed.searchParams.get("contextId") ?? undefined;

  let repoArgs: Record<string, RepoArgSpec> | undefined;
  const repoArgsParam = parsed.searchParams.get("repoArgs");
  if (repoArgsParam) {
    try {
      const parsedJson = JSON.parse(repoArgsParam);
      const result = RepoArgsSchema.safeParse(parsedJson);
      if (result.success) {
        repoArgs = result.data;
      } else {
        throw new Error(`Invalid repoArgs in ns URL: ${result.error.message}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("Invalid JSON in repoArgs parameter");
      }
      throw e;
    }
  }

  let env: Record<string, string> | undefined;
  const envParam = parsed.searchParams.get("env");
  if (envParam) {
    try {
      const parsedEnv = JSON.parse(envParam);
      if (typeof parsedEnv === "object" && parsedEnv !== null) {
        // Validate all values are strings
        const isValid = Object.values(parsedEnv).every((v) => typeof v === "string");
        if (isValid) {
          env = parsedEnv as Record<string, string>;
        } else {
          throw new Error("Invalid env in ns URL: all values must be strings");
        }
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("Invalid JSON in env parameter");
      }
      throw e;
    }
  }

  // Parse stateArgs (validation against schema happens in panelManager)
  let stateArgs: Record<string, unknown> | undefined;
  const stateArgsParam = parsed.searchParams.get("stateArgs");
  if (stateArgsParam) {
    try {
      stateArgs = JSON.parse(stateArgsParam);
    } catch {
      throw new Error("Invalid stateArgs JSON in URL");
    }
  }

  return { source, action, gitRef, contextId, repoArgs, env, stateArgs, name, focus };
}

export interface BuildNsUrlOptions {
  action?: NsAction;
  /**
   * Git ref (branch/tag/commit) for the panel source.
   */
  gitRef?: string;
  /**
   * Explicit context ID for storage partition sharing.
   * If provided, the panel will use this context ID instead of generating a new one.
   */
  contextId?: string;
  repoArgs?: Record<string, RepoArgSpec>;
  env?: Record<string, string>;
  /** State arguments for the panel (validated against manifest schema in panelManager) */
  stateArgs?: Record<string, unknown>;
  name?: string;
  /** If true, immediately focus the new panel after creation (only applies to action=child on app panels) */
  focus?: boolean;
}

/**
 * Build an ns:// URL from source and options.
 */
export function buildNsUrl(source: string, options?: BuildNsUrlOptions): string {
  const encodedPath = encodeURIComponent(source).replace(/%2F/g, "/"); // keep slashes readable
  const searchParams = new URLSearchParams();

  if (options?.action && options.action !== "navigate") {
    searchParams.set("action", options.action);
  }
  if (options?.gitRef) {
    searchParams.set("gitRef", options.gitRef);
  }
  if (options?.contextId) {
    searchParams.set("contextId", options.contextId);
  }
  if (options?.repoArgs) {
    searchParams.set("repoArgs", JSON.stringify(options.repoArgs));
  }
  if (options?.env) {
    searchParams.set("env", JSON.stringify(options.env));
  }
  if (options?.stateArgs) {
    searchParams.set("stateArgs", JSON.stringify(options.stateArgs));
  }
  if (options?.name) {
    searchParams.set("name", options.name);
  }
  if (options?.focus) {
    searchParams.set("focus", "true");
  }

  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  return `ns:///${encodedPath}${params}`;
}
