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

import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("DODispatch");

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

  /**
   * Set the HTTP dispatcher function used by dispatch().
   * Must be called before any dispatch calls.
   */
  setDispatcher(fn: HttpDispatcher): void {
    this.dispatcher = fn;
  }

  /**
   * Dispatch a method call to a DO via HTTP POST.
   * Returns the parsed JSON response (type depends on the DO method).
   */
  async dispatch(ref: DORef, method: string, ...args: unknown[]): Promise<unknown> {
    if (!this.dispatcher) {
      throw new Error("DODispatch: no dispatcher configured");
    }
    const urlPath = doRefUrl(ref, method);
    log.verbose(`Dispatch: ${doRefKey(ref)}.${method}`);
    return this.dispatcher(urlPath, args);
  }
}
