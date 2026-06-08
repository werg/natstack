import { describe, expect, it } from "vitest";

import { pickRecommendedModelId } from "./modelRecommendations";

describe("modelRecommendations", () => {
  it("prefers flagship provider families over smaller variants", () => {
    expect(
      pickRecommendedModelId("anthropic", [
        { id: "claude-3-5-haiku-latest" },
        { id: "claude-3-5-sonnet-20241022" },
      ])
    ).toBe("claude-3-5-sonnet-20241022");

    expect(
      pickRecommendedModelId("google", [
        { id: "gemini-2.5-flash" },
        { id: "gemini-2.5-pro" },
      ])
    ).toBe("gemini-2.5-pro");
  });
});
