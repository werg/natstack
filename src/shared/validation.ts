import typia, { type IValidation } from "typia";
import { createAIError } from "./errors.js";
import type { AIToolDefinition } from "@natstack/ai";

/**
 * Typia-backed validation helpers for AI payloads.
 * Throws AIError with helpful context on validation failure.
 */

const toolValidator = typia.createValidate<AIToolDefinition[]>();

function formatValidationError(error: IValidation.IError): string {
  const path = error.path ?? "input";
  const expected = error.expected ?? "unknown";
  const value = JSON.stringify(error.value);
  return `${path}: expected ${expected}, received ${value}`;
}

function assertWithValidator<T>(context: string, result: IValidation<T>): T {
  if (result.success) return result.data;
  const first = result.errors[0];
  const detail = first ? formatValidationError(first) : "unknown validation error";
  throw createAIError("internal_error", `${context} validation failed (${detail})`);
}

export function validateToolDefinitions(tools: unknown): AIToolDefinition[] | undefined {
  if (tools === undefined) return undefined;
  return assertWithValidator("AI tool definitions", toolValidator(tools));
}
