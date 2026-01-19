/**
 * Protocol parser for ns:// URLs.
 *
 * URL Format: ns:///{source}?action={navigate|child}&context={context}&repoArgs={json}&gitRef={ref}
 *
 * Examples:
 *   ns:///panels/editor
 *   ns:///panels/editor?action=child
 *   ns:///workers/background-task
 *   ns:///panels/editor?gitRef=main
 *   ns:///panels/editor?repoArgs=%7B%22workspace%22%3A%22repos%2Fapp%22%7D
 */

import { z } from "zod";
import type { RepoArgSpec } from "../shared/ipc/types.js";

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
  gitRef?: string;
  context?: string;
  repoArgs?: Record<string, RepoArgSpec>;
  ephemeral?: boolean;
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

  const context = parsed.searchParams.get("context") ?? undefined;
  const gitRef = parsed.searchParams.get("gitRef") ?? undefined;
  const ephemeral = parsed.searchParams.get("ephemeral") === "true" || undefined;

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

  return { source, action, gitRef, context, repoArgs, ephemeral };
}

export interface BuildNsUrlOptions {
  action?: NsAction;
  gitRef?: string;
  context?: string;
  repoArgs?: Record<string, RepoArgSpec>;
  ephemeral?: boolean;
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
  if (options?.context) {
    searchParams.set("context", options.context);
  }
  if (options?.gitRef) {
    searchParams.set("gitRef", options.gitRef);
  }
  if (options?.repoArgs) {
    searchParams.set("repoArgs", JSON.stringify(options.repoArgs));
  }
  if (options?.ephemeral) {
    searchParams.set("ephemeral", "true");
  }

  const paramsStr = searchParams.toString();
  const params = paramsStr ? `?${paramsStr}` : "";
  return `ns:///${encodedPath}${params}`;
}
