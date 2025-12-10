import type { ComponentType } from "react";

/**
 * Check if a value is a valid React component.
 * Handles function components, forwardRef, memo, lazy, etc.
 */
export function isValidComponent(value: unknown): value is ComponentType {
  if (typeof value === "function") {
    return true;
  }
  // ForwardRef, Memo, lazy, etc. have $$typeof
  if (typeof value === "object" && value !== null && "$$typeof" in value) {
    return true;
  }
  return false;
}
