/**
 * Structured error handling for AI SDK integration.
 *
 * Errors are typed with specific codes that allow clients to handle
 * different failure modes programmatically.
 */

export type AIErrorCode =
  | "model_not_found"
  | "provider_not_found"
  | "invalid_credentials"
  | "api_error"
  | "rate_limited"
  | "context_length_exceeded"
  | "content_filtered"
  | "request_timeout"
  | "stream_cancelled"
  | "internal_error"
  | "unauthorized";

export interface AIError extends Error {
  code: AIErrorCode;
  details?: unknown;
  retryable: boolean;
  originalError?: Error;
}

export function createAIError(
  code: AIErrorCode,
  message: string,
  options?: {
    details?: unknown;
    retryable?: boolean;
    cause?: Error;
  }
): AIError {
  const error = new Error(message) as AIError;
  error.code = code;
  error.details = options?.details;
  error.retryable = options?.retryable ?? isRetryableErrorCode(code);
  error.originalError = options?.cause;
  return error;
}

function isRetryableErrorCode(code: AIErrorCode): boolean {
  return ["rate_limited", "request_timeout", "api_error"].includes(code);
}

/**
 * Map common AI SDK errors to our error codes.
 */
export function mapAISDKError(error: unknown): AIError {
  if (isAIError(error)) {
    return error;
  }

  const err = error instanceof Error ? error : new Error(String(error));

  // Map by error message patterns
  const message = err.message.toLowerCase();

  if (message.includes("not found") || message.includes("unknown model")) {
    return createAIError("model_not_found", err.message, { cause: err });
  }
  if (message.includes("authentication") || message.includes("api key")) {
    return createAIError("invalid_credentials", err.message, { cause: err });
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return createAIError("rate_limited", err.message, { cause: err, retryable: true });
  }
  if (message.includes("timeout")) {
    return createAIError("request_timeout", err.message, { cause: err, retryable: true });
  }
  if (message.includes("content filter") || message.includes("content policy")) {
    return createAIError("content_filtered", err.message, { cause: err });
  }
  if (message.includes("context length") || message.includes("too long")) {
    return createAIError("context_length_exceeded", err.message, { cause: err });
  }

  return createAIError("api_error", err.message, { cause: err });
}

export function isAIError(error: unknown): error is AIError {
  return error instanceof Error && "code" in error && "retryable" in error;
}

/**
 * Serialize error for IPC transmission.
 */
export function serializeError(error: unknown): {
  message: string;
  code?: string;
  details?: unknown;
} {
  if (isAIError(error)) {
    return {
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
    };
  }

  return {
    message: String(error),
  };
}
