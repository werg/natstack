/**
 * DODispatch -- source-scoped HTTP dispatch to Durable Objects.
 *
 * Replaces WorkerRouter with a simpler model:
 * - DORef identifies a DO by source + className + objectKey
 * - dispatch() makes HTTP POST to /_w/{source}/{className}/{objectKey}/__rpc
 * - No participant maps, no harness maps, no action types
 *
 * The `/_w/` URL scheme uses 2-segment source paths (e.g., "workers/agent-worker"),
 * so the generated workerd router can parse deterministically:
 *   segments[0]+segments[1] = source
 *   segment[2] = className
 *   segment[3] = objectKey
 *   rest = "__rpc"
 */

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

/** Build the /_w/ URL path for a DO RPC envelope. */
export function doRefRpcUrl(ref: DORef): string {
  return `/_w/${ref.source}/${encodeURIComponent(ref.className)}/${encodeURIComponent(ref.objectKey)}/__rpc`;
}

export interface PostToDODeps {
  workerdUrl: string;
  workerdGatewayToken: string;
}

export async function postRpcToDO(
  ref: DORef,
  envelope: Record<string, unknown>,
  deps: PostToDODeps
): Promise<unknown> {
  const url = `${deps.workerdUrl}${doRefRpcUrl(ref)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deps.workerdGatewayToken}`,
    },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DO dispatch failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (json["error"]) {
    const err = new Error(json["error"] as string);
    if (json["errorCode"]) {
      (err as Error & { code?: unknown }).code = json["errorCode"];
    }
    throw err;
  }
  return json["result"];
}

// ---------------------------------------------------------------------------
// DODispatch — generic HTTP POST dispatch to DOs
// ---------------------------------------------------------------------------

/**
 * A dispatcher function that makes HTTP POST to a /_w/ URL and returns
 * the parsed JSON response. Injected by the server wiring.
 */
export type HttpDispatcher = (urlPath: string, body: unknown) => Promise<unknown>;

export class DODispatch {
  private dispatcher: HttpDispatcher | null = null;
  private ensureDOFn:
    | ((source: string, className: string, objectKey: string) => Promise<void>)
    | null = null;
  private beforeDispatchFn: ((ref: DORef) => Promise<void> | void) | null = null;
  private getWorkerdUrl: (() => string) | null = null;
  private getWorkerdGatewayToken: (() => string) | null = null;

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

  setBeforeDispatch(fn: (ref: DORef) => Promise<void> | void): void {
    this.beforeDispatchFn = fn;
  }

  /**
   * Set a function that returns the current base workerd URL
   * (e.g. "http://127.0.0.1:8787"). Called on each dispatch so the
   * port can be resolved dynamically.
   */
  setGetWorkerdUrl(fn: () => string): void {
    this.getWorkerdUrl = fn;
  }

  setGetWorkerdGatewayToken(fn: () => string): void {
    this.getWorkerdGatewayToken = fn;
  }

  /**
   * Dispatch a method call to a DO via the runtime RPC endpoint.
   * Returns the parsed JSON response (type depends on the DO method).
   * On retryable errors (DO class not found, ECONNREFUSED), calls ensureDO and retries once.
   *
   * When workerdUrl is configured, sends directly through the gateway-to-workerd
   * bearer hop. Tests may still inject a dispatcher function.
   */
  async dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown> {
    await Promise.resolve(this.beforeDispatchFn?.(ref));

    if (this.getWorkerdUrl && this.getWorkerdGatewayToken) {
      const buildDeps = (): PostToDODeps => ({
        workerdUrl: this.getWorkerdUrl!(),
        workerdGatewayToken: this.getWorkerdGatewayToken!(),
      });
      try {
        return await postRpcToDO(ref, { type: "call", method, args, sourceId: "main" }, buildDeps());
      } catch (err) {
        if (this.ensureDOFn && this.isRetryable(err)) {
          console.warn(
            `[DODispatch] ${doRefKey(ref)}.${method} failed (${err instanceof Error ? err.message : String(err)}), calling ensureDO and retrying`
          );
          await this.ensureDOFn(ref.source, ref.className, ref.objectKey);
          await Promise.resolve(this.beforeDispatchFn?.(ref));
          return await postRpcToDO(ref, { type: "call", method, args, sourceId: "main" }, buildDeps());
        }
        throw err;
      }
    }

    if (!this.dispatcher) {
      throw new Error("DODispatch: no dispatcher configured");
    }
    const urlPath = doRefRpcUrl(ref);
    try {
      return await this.dispatcher(urlPath, { type: "call", method, args, sourceId: "main" });
    } catch (err) {
      if (this.ensureDOFn && this.isRetryable(err)) {
        console.warn(
          `[DODispatch] ${doRefKey(ref)}.${method} failed (${err instanceof Error ? err.message : String(err)}), calling ensureDO and retrying`
        );
        await this.ensureDOFn(ref.source, ref.className, ref.objectKey);
        await Promise.resolve(this.beforeDispatchFn?.(ref));
        return await this.dispatcher(urlPath, { type: "call", method, args, sourceId: "main" });
      }
      throw err;
    }
  }

  private isRetryable(err: unknown): boolean {
    const msg = String(err);
    const cause = err instanceof Error && "cause" in err ? String(err.cause) : "";
    return (
      msg.includes("DO class not found") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("workerd not running") ||
      cause.includes("ECONNREFUSED")
    );
  }
}
