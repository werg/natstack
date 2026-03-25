/**
 * DODispatch -- source-scoped HTTP dispatch to Durable Objects.
 *
 * Replaces WorkerRouter with a simpler model:
 * - DORef identifies a DO by source + className + objectKey
 * - dispatch() makes HTTP POST to /_w/{source}/{className}/{objectKey}/{method}
 * - No participant maps, no harness maps, no action types
 *
 * The `/_w/` URL scheme uses 2-segment source paths (e.g., "workers/agent-worker"),
 * so the generated workerd router can parse deterministically:
 *   segments[0]+segments[1] = source
 *   segment[2] = className
 *   segment[3] = objectKey
 *   rest = method path
 */

import type { TokenManager } from "../shared/tokenManager.js";

// ---------------------------------------------------------------------------
// DORef — source-scoped Durable Object identity
// ---------------------------------------------------------------------------

export interface DORef {
  /** Workspace-relative path, e.g. "workers/agent-worker" */
  source: string;
  /** DO class name, scoped to source, e.g. "AiChatWorker" */
  className: string;
  /** Stable instance identifier, e.g. "ch-123" */
  objectKey: string;
}

/** Canonical string key for a DORef, used for maps and logging. */
export function doRefKey(ref: DORef): string {
  return `${ref.source}:${ref.className}/${ref.objectKey}`;
}

/** Build the /_w/ URL path for a DO method call. */
export function doRefUrl(ref: DORef, method: string): string {
  return `/_w/${ref.source}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}/${encodeURIComponent(method)}`;
}

// ---------------------------------------------------------------------------
// postToDOWithToken — standalone dispatch with per-instance identity token
// ---------------------------------------------------------------------------

export interface PostToDOWithTokenDeps {
  tokenManager: TokenManager;
  workerdUrl: string;
}

/**
 * Dispatch an RPC method call to a Durable Object via HTTP POST,
 * attaching a per-instance identity token (X-Instance-Token) and
 * optional parent ID (X-Parent-Id) header.
 *
 * The instance ID used for token minting is "do:{source}:{className}:{objectKey}".
 */
export async function postToDOWithToken(
  ref: DORef,
  method: string,
  args: unknown[],
  deps: PostToDOWithTokenDeps,
  callerId?: string,
): Promise<unknown> {
  // 1. Build the instance ID for this DO: "do:{source}:{className}:{objectKey}"
  const instanceId = `do:${ref.source}:${ref.className}:${ref.objectKey}`;

  // 2. Mint/retrieve a per-instance token
  const token = deps.tokenManager.ensureToken(instanceId, "worker");

  // 3. Build URL: workerdUrl + doRefUrl(ref, method)
  const url = `${deps.workerdUrl}${doRefUrl(ref, method)}`;

  // 4. POST with identity in the body envelope (not headers, which workerd may strip
  // on internal subrequests from the router to DO stubs).
  const envelope = {
    args,
    __instanceToken: token,
    __instanceId: instanceId,
    __parentId: callerId ?? undefined,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO dispatch failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// DODispatch — generic HTTP POST dispatch to DOs
// ---------------------------------------------------------------------------

/**
 * A dispatcher function that makes HTTP POST to a /_w/ URL and returns
 * the parsed JSON response. Injected by the server wiring.
 */
export type HttpDispatcher = (
  urlPath: string,
  args: unknown[],
) => Promise<unknown>;

export class DODispatch {
  private dispatcher: HttpDispatcher | null = null;
  private ensureDOFn: ((source: string, className: string, objectKey: string) => Promise<void>) | null = null;
  private tokenManager: TokenManager | null = null;
  private getWorkerdUrl: (() => string) | null = null;

  /**
   * Set the HTTP dispatcher function used by dispatch().
   * Must be called before any dispatch calls.
   */
  setDispatcher(fn: HttpDispatcher): void {
    this.dispatcher = fn;
  }

  /**
   * Set the ensureDO callback for retry-on-failure.
   * When a dispatch fails with a retryable error, ensureDO is called to
   * re-register the service and restart workerd before retrying.
   */
  setEnsureDO(fn: (source: string, className: string, objectKey: string) => Promise<void>): void {
    this.ensureDOFn = fn;
  }

  /**
   * Set the TokenManager for per-instance identity tokens.
   * When set (along with workerdUrl), dispatch() will use postToDOWithToken
   * to attach X-Instance-Token and X-Parent-Id headers.
   */
  setTokenManager(tm: TokenManager): void {
    this.tokenManager = tm;
  }

  /**
   * Set a function that returns the current base workerd URL
   * (e.g. "http://127.0.0.1:8787"). Called on each dispatch so the
   * port can be resolved dynamically.
   */
  setGetWorkerdUrl(fn: () => string): void {
    this.getWorkerdUrl = fn;
  }

  /**
   * Dispatch a method call to a DO via HTTP POST.
   * Returns the parsed JSON response (type depends on the DO method).
   * On retryable errors (DO class not found, ECONNREFUSED), calls ensureDO and retries once.
   *
   * When tokenManager and workerdUrl are configured, uses postToDOWithToken
   * to include per-instance identity tokens. Otherwise falls back to the
   * raw dispatcher function.
   */
  async dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown> {
    // Token-based path: use postToDOWithToken when tokenManager + getWorkerdUrl are set
    if (this.tokenManager && this.getWorkerdUrl) {
      const deps: PostToDOWithTokenDeps = {
        tokenManager: this.tokenManager,
        workerdUrl: this.getWorkerdUrl(),
      };
      try {
        return await postToDOWithToken(ref, method, args, deps);
      } catch (err) {
        if (this.ensureDOFn && this.isRetryable(err)) {
          console.warn(`[DODispatch] ${doRefKey(ref)}.${method} failed (${err instanceof Error ? err.message : String(err)}), calling ensureDO and retrying`);
          await this.ensureDOFn(ref.source, ref.className, ref.objectKey);
          return await postToDOWithToken(ref, method, args, deps);
        }
        throw err;
      }
    }

    // Legacy path: use raw dispatcher (no token headers)
    if (!this.dispatcher) {
      throw new Error("DODispatch: no dispatcher configured");
    }
    const urlPath = doRefUrl(ref, method);
    try {
      return await this.dispatcher(urlPath, args);
    } catch (err) {
      if (this.ensureDOFn && this.isRetryable(err)) {
        console.warn(`[DODispatch] ${doRefKey(ref)}.${method} failed (${err instanceof Error ? err.message : String(err)}), calling ensureDO and retrying`);
        await this.ensureDOFn(ref.source, ref.className, ref.objectKey);
        return await this.dispatcher(urlPath, args);
      }
      throw err;
    }
  }

  private isRetryable(err: unknown): boolean {
    const msg = String(err);
    return msg.includes("DO class not found") || msg.includes("ECONNREFUSED") || msg.includes("workerd not running");
  }
}
