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

import { constantTimeStringEqual, type TokenManager } from "@natstack/shared/tokenManager";

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
  /**
   * Per-process dispatch secret stamped onto internal `/_w/` dispatches as
   * the `X-NatStack-Dispatch-Secret` header. The auto-generated workerd router
   * validates this header when present, while allowing public DO routes that
   * cannot know the process-private secret.
   *
   * Optional because public route paths and some tests do not need it.
   */
  dispatchSecret?: string;
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

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deps.dispatchSecret) {
    headers["X-NatStack-Dispatch-Secret"] = deps.dispatchSecret;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO dispatch failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// verifyInstanceTokenEnvelope — server-side guard for inbound DO requests
// ---------------------------------------------------------------------------

export interface InstanceTokenEnvelope {
  args?: unknown;
  __instanceToken?: unknown;
  __instanceId?: unknown;
  __parentId?: unknown;
}

export interface VerifyInstanceTokenResult {
  ok: boolean;
  reason?: string;
  /** When ok, the resolved parentId (caller) attribution. */
  parentId?: string | undefined;
}

/**
 * Verify the `__instanceToken` envelope attached by `postToDOWithToken`.
 *
 * The envelope is attached because workerd's HTTP router strips arbitrary
 * headers on internal subrequests, so we cannot use a plain bearer header.
 * The legitimate path is:
 *
 *   gateway-process: ensureToken(instanceId, "worker") → token T
 *   gateway-process: POST /_w/.../method body={ args, __instanceToken: T,
 *                                               __instanceId, __parentId }
 *   workerd-process: must verify T against the same TokenManager.
 *
 * Today there is no workerd-side verifier (audit finding #29). This helper
 * is a server-side guard that callers MUST invoke before dispatching the
 * envelope into a DO method handler:
 *
 *   - Validates `__instanceToken` is present and matches the token issued
 *     to `__instanceId` in the in-process TokenManager.
 *   - Returns the verified `__parentId` so the DO handler can use it as
 *     the caller attribution (overwriting any value provided in `args`).
 *
 * Wave-2 status (audit 4.8): the receiver inside workerd is the
 * auto-generated router worker (see `WorkerdManager.generateRouterCode`).
 * The router rejects a request when an `X-NatStack-Dispatch-Secret` header is
 * present but does not match `WorkerdManager.dispatchSecret`; absence is
 * allowed so public DO routes keep working. The TokenManager-based envelope
 * check below is the
 * server-side guard intended for any *in-process* code path that wants
 * to validate the envelope (e.g., test harnesses, future direct-dispatch
 * shims), but workerd itself never calls it — the runtime is bundled JS
 * with no link to the host TokenManager. The router-level shared-secret
 * check is the production-grade enforcement.
 */
export function verifyInstanceTokenEnvelope(
  envelope: InstanceTokenEnvelope,
  tokenManager: TokenManager,
): VerifyInstanceTokenResult {
  const { __instanceToken, __instanceId, __parentId } = envelope;
  if (typeof __instanceToken !== "string" || __instanceToken.length === 0) {
    return { ok: false, reason: "missing __instanceToken" };
  }
  if (typeof __instanceId !== "string" || __instanceId.length === 0) {
    return { ok: false, reason: "missing __instanceId" };
  }
  const entry = tokenManager.validateToken(__instanceToken);
  if (!entry) {
    return { ok: false, reason: "unknown __instanceToken" };
  }
  // Constant-time compare of the verified token's callerId against the
  // claimed __instanceId — callerId is server-controlled (it comes from
  // tokenManager) and __instanceId is attacker-controllable, so the
  // comparison itself does not expose a secret, but we use constant-time
  // for consistency with other token compares.
  if (!constantTimeStringEqual(entry.callerId, __instanceId)) {
    return { ok: false, reason: "instanceId/token mismatch" };
  }
  const parentId =
    typeof __parentId === "string" && __parentId.length > 0
      ? __parentId
      : undefined;
  return { ok: true, parentId };
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
  private getDispatchSecret: (() => string) | null = null;

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
   * Set a function that returns the current per-process dispatch secret
   * (`WorkerdManager.getDispatchSecret()`). Stamped onto every `/_w/`
   * request as `X-NatStack-Dispatch-Secret` and verified by the
   * auto-generated workerd router worker. Closes audit finding 4.8.
   *
   * Called on each dispatch so a workerd restart that rotates the secret
   * is picked up without re-wiring.
   */
  setGetDispatchSecret(fn: () => string): void {
    this.getDispatchSecret = fn;
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
        dispatchSecret: this.getDispatchSecret ? this.getDispatchSecret() : undefined,
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
