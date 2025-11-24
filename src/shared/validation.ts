import typia, { type IValidation } from "typia";
import { createAIError } from "./errors.js";
import type {
  AICallWarning,
  AIGenerateResult,
  AIMessage,
  AIResponseContent,
  AIToolDefinition,
  AIFinishReason,
  AIUsage,
  AIResponseMetadata,
} from "./ipc/index.js";

/**
 * Typia-backed validation helpers for AI payloads.
 * Throws AIError with helpful context on validation failure.
 */

type SDKResponseInput = {
  content?: unknown;
  finishReason?: unknown;
  usage?: { promptTokens?: unknown; completionTokens?: unknown };
  warnings?: Array<{ type?: unknown; message?: unknown; details?: unknown }>;
  response?: { id?: unknown; modelId?: unknown; timestamp?: unknown };
};

const promptValidator = typia.createValidate<AIMessage[]>();
const toolValidator = typia.createValidate<AIToolDefinition[]>();
const responseContentValidator = typia.createValidate<AIResponseContent[]>();
const sdkResponseValidator = typia.createValidate<SDKResponseInput>();

const FINISH_REASONS: Set<AIFinishReason> = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);

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

export function validatePrompt(prompt: AIMessage[]): AIMessage[] {
  return assertWithValidator("AI prompt", promptValidator(prompt));
}

export function validateToolDefinitions(tools?: AIToolDefinition[]): AIToolDefinition[] | undefined {
  if (tools === undefined) return undefined;
  return assertWithValidator("AI tool definitions", toolValidator(tools));
}

export function validateResponseContent(content: unknown[]): AIResponseContent[] {
  return assertWithValidator("AI response content", responseContentValidator(content));
}

export function validateFinishReason(reason: unknown): AIFinishReason {
  if (typeof reason === "string" && FINISH_REASONS.has(reason as AIFinishReason)) {
    return reason as AIFinishReason;
  }
  return "unknown";
}

export function validateSDKResponse(result: unknown): AIGenerateResult {
  const sdkResponse = assertWithValidator("AI SDK response", sdkResponseValidator(result));

  const usage: AIUsage = {
    promptTokens: typeof sdkResponse.usage?.promptTokens === "number" ? sdkResponse.usage.promptTokens : 0,
    completionTokens: typeof sdkResponse.usage?.completionTokens === "number" ? sdkResponse.usage.completionTokens : 0,
  };

  const warnings: AICallWarning[] = (sdkResponse.warnings ?? []).map((warning, idx) => ({
    type: typeof warning.type === "string" ? warning.type : `warning-${idx}`,
    message: typeof warning.message === "string" ? warning.message : "Unknown warning",
    details: warning.details,
  }));

  let response: AIResponseMetadata | undefined;
  if (sdkResponse.response) {
    response = {
      id: typeof sdkResponse.response.id === "string" ? sdkResponse.response.id : undefined,
      modelId: typeof sdkResponse.response.modelId === "string" ? sdkResponse.response.modelId : undefined,
      timestamp:
        sdkResponse.response.timestamp instanceof Date
          ? sdkResponse.response.timestamp.toISOString()
          : typeof sdkResponse.response.timestamp === "string"
            ? sdkResponse.response.timestamp
            : undefined,
    };
  }

  return {
    content: validateResponseContent(Array.isArray(sdkResponse.content) ? sdkResponse.content : []),
    finishReason: validateFinishReason(sdkResponse.finishReason),
    usage,
    warnings,
    response,
  };
}
