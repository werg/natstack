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

export interface MessageTypeModule {
  default?: ComponentType<CustomMessageComponentProps>;
  reduce?: (state: unknown, update: unknown) => unknown;
  schema?: unknown;
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
  return updates.reduce((state, item) => reducer(state, item.update), initialState);
}
