import { rpc } from "./rpc.js";

declare const __env: Record<string, string>;

function getParentId(): string | null {
  const parentId = __env["PARENT_ID"];
  if (typeof parentId !== "string" || parentId.length === 0) {
    return null;
  }
  return parentId;
}

/**
 * Parent handle for workers.
 *
 * Mirrors the ergonomics of panel parent handles, backed by `rpc.call/emit`.
 * If no parent exists, `emit()` is a noop and `call()` throws.
 */
export const parent = {
  emit(event: string, payload: unknown): Promise<void> {
    const parentId = getParentId();
    if (!parentId) {
      return Promise.resolve();
    }
    return rpc.emit(parentId, event, payload);
  },

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const parentId = getParentId();
    if (!parentId) {
      throw new Error("No parent");
    }
    return rpc.call<T>(parentId, method, ...args);
  },
};

