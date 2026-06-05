import type { ComponentType } from "react";
import { compileModule, type CompileComponentOptions } from "@workspace/eval";

export interface CustomMessageComponentProps {
  messageId: string;
  typeId: string;
  state: unknown;
  expanded: boolean;
  displayMode: "inline" | "row";
  chat: Record<string, unknown>;
  scope: Record<string, unknown>;
  scopes: Record<string, unknown>;
}

/**
 * A `schema` export may be either a validation function returning error
 * messages (empty/null = valid) or a Zod-like object exposing `.safeParse`.
 */
export type CustomMessageValidator =
  | ((state: unknown) => string[] | string | null | undefined | void)
  | { safeParse: (state: unknown) => { success: boolean; error?: unknown } };

export interface MessageTypeModule {
  default?: ComponentType<CustomMessageComponentProps>;
  /** Optional compact renderer for the collapsed inline view (expanded === false). */
  Pill?: ComponentType<CustomMessageComponentProps>;
  reduce?: (state: unknown, update: unknown) => unknown;
  schema?: CustomMessageValidator | unknown;
  [key: string]: unknown;
}

export async function compileMessageTypeModule(
  code: string,
  options: CompileComponentOptions = {},
) {
  return compileModule<MessageTypeModule>(code, options);
}

export function foldCustomMessageState(
  initialState: unknown,
  updates: Array<{ update: unknown; seq: number }>,
  reducer?: (state: unknown, update: unknown) => unknown,
): unknown {
  if (!reducer) {
    return updates.length > 0 ? updates[updates.length - 1]?.update : initialState;
  }
  // A throwing reducer must not blank the whole card: keep the last good state,
  // warn, and continue folding the remaining updates.
  return updates.reduce((state, item) => {
    try {
      return reducer(state, item.update);
    } catch (err) {
      console.warn("[custom-message] reducer threw; keeping prior state", err);
      return state;
    }
  }, initialState);
}

/**
 * Validate folded state against an optional module `schema` export. Returns a
 * list of human-readable error messages, or null when valid / no validator.
 * Runs at the panel consume boundary (the only place the compiled module
 * exists) — never in the channel reducer.
 */
export function validateCustomState(
  validator: CustomMessageValidator | unknown,
  state: unknown,
): string[] | null {
  if (!validator) return null;
  try {
    if (typeof validator === "function") {
      const result = (validator as (s: unknown) => unknown)(state);
      if (result == null || result === true) return null;
      if (typeof result === "string") return result ? [result] : null;
      if (Array.isArray(result)) return result.length ? result.map(String) : null;
      return null;
    }
    if (typeof validator === "object" && typeof (validator as { safeParse?: unknown }).safeParse === "function") {
      const parsed = (validator as { safeParse: (s: unknown) => { success: boolean; error?: unknown } }).safeParse(state);
      if (parsed.success) return null;
      return [formatValidatorError(parsed.error)];
    }
  } catch (err) {
    return [`schema validation threw: ${err instanceof Error ? err.message : String(err)}`];
  }
  return null;
}

function formatValidatorError(error: unknown): string {
  if (!error) return "schema validation failed";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
  if (Array.isArray(issues) && issues.length) {
    return issues
      .map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message ?? "invalid"}`;
      })
      .join("; ");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
