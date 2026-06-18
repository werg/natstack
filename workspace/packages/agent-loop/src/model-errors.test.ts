import { describe, expect, it } from "vitest";
import { classifyModelFailure, modelFailureInputFromUnknown } from "./model-errors.js";

const now = "2026-06-15T18:00:00.000Z";

describe("classifyModelFailure", () => {
  it("treats Codex usage limits as terminal and readable", () => {
    const failure = classifyModelFailure({
      provider: "openai-codex",
      now,
      rawReason: `Codex error: ${JSON.stringify({
        type: "error",
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          resets_at: 1781548501,
        },
        headers: {
          "X-Codex-Bengalfox-Limit-Name": "GPT-5.3 Codex-Spark",
        },
      })}`,
    });

    expect(failure).toMatchObject({
      code: "usage_limit_terminal",
      recoverable: false,
      resetAt: "2026-06-15T18:35:01.000Z",
      reason:
        "The usage limit has been reached for GPT-5.3 Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
    });
  });

  it("extracts embedded provider JSON from thrown Error messages", () => {
    const rawReason = `Codex error: ${JSON.stringify({
      type: "error",
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
        resets_at: 1781548501,
      },
      headers: {
        "X-Codex-Bengalfox-Limit-Name": "GPT-5.3 Codex-Spark",
      },
    })}`;
    const failure = classifyModelFailure(
      modelFailureInputFromUnknown(new Error(rawReason), { now })
    );

    expect(failure).toMatchObject({
      code: "usage_limit_terminal",
      recoverable: false,
      resetAt: "2026-06-15T18:35:01.000Z",
      reason:
        "The usage limit has been reached for GPT-5.3 Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
    });
  });

  it("treats OpenAI-compatible rate limits as retryable", () => {
    const failure = classifyModelFailure({
      provider: "openai",
      status: 429,
      headers: { "retry-after": "12" },
      body: {
        error: {
          type: "rate_limit_exceeded",
          message: "Rate limit reached for requests.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "rate_limited_retryable",
      recoverable: true,
      retryAfterMs: 12_000,
      reason: "Rate limit reached for requests.",
    });
  });

  it("treats ChatGPT token_expired detail bodies as auth failures", () => {
    const failure = classifyModelFailure({
      provider: "openai-codex",
      status: 401,
      body: {
        detail: {
          code: "token_expired",
          message: "Provided authentication token is expired. Please try signing in again.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "auth_or_credentials",
      recoverable: false,
      reason: "Provided authentication token is expired. Please try signing in again.",
    });
  });

  it("treats token-expired prose as an auth failure", () => {
    const failure = classifyModelFailure({
      provider: "openai-codex",
      rawReason: "WebSocket failed: token expired",
      now,
    });

    expect(failure).toMatchObject({
      code: "auth_or_credentials",
      recoverable: false,
    });
  });

  it("treats OpenAI-compatible insufficient quota as terminal", () => {
    const failure = classifyModelFailure({
      provider: "openrouter",
      status: 429,
      body: {
        error: {
          code: "insufficient_quota",
          message: "You exceeded your current quota, please check your plan and billing details.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "quota_exhausted_terminal",
      recoverable: false,
    });
  });

  it("treats Anthropic overload as retryable", () => {
    const failure = classifyModelFailure({
      provider: "anthropic",
      status: 529,
      body: {
        error: {
          type: "overloaded_error",
          message: "The API is temporarily overloaded.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "provider_overloaded_retryable",
      recoverable: true,
      retryAfterMs: 10_000,
    });
  });

  it("treats Gemini RESOURCE_EXHAUSTED rate limits with retry hints as retryable", () => {
    const failure = classifyModelFailure({
      provider: "google",
      status: 429,
      body: {
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "You've exceeded the rate limit. Please retry in 20.750145274s.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "rate_limited_retryable",
      recoverable: true,
      retryAfterMs: 20_751,
    });
  });

  it("treats Gemini billing quota errors as terminal", () => {
    const failure = classifyModelFailure({
      provider: "google",
      status: 429,
      body: {
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "You exceeded your current quota, please check your plan and billing details.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "quota_exhausted_terminal",
      recoverable: false,
    });
  });

  it("treats Bedrock throttling as retryable but service quota as terminal", () => {
    expect(
      classifyModelFailure({
        provider: "amazon-bedrock",
        rawReason: "ThrottlingException: Too many tokens, please wait before trying again.",
        now,
      })
    ).toMatchObject({
      code: "rate_limited_retryable",
      recoverable: true,
      retryAfterMs: 30_000,
    });

    expect(
      classifyModelFailure({
        provider: "amazon-bedrock",
        rawReason: "ServiceQuotaExceededException: Your account exceeded service quota.",
        now,
      })
    ).toMatchObject({
      code: "quota_exhausted_terminal",
      recoverable: false,
    });
  });

  it("formats long retry reset times readably when stopping automatic retries", () => {
    const failure = classifyModelFailure({
      provider: "openai",
      status: 429,
      headers: { "retry-after": "3600" },
      body: {
        error: {
          type: "rate_limit_exceeded",
          message: "Rate limit reached for requests.",
        },
      },
      now,
    });

    expect(failure).toMatchObject({
      code: "rate_limited_retryable",
      recoverable: false,
      resetAt: "2026-06-15T19:00:00.000Z",
      reason: "Rate limit reached for requests. Try again after Jun 15, 2026 at 7:00 PM UTC.",
    });
  });
});
