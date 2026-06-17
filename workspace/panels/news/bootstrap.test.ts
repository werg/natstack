import { describe, expect, it } from "vitest";
import { deepDivePrompt, newsAgentKey, newsChannelName, resolveNewsContextId } from "./bootstrap.js";

describe("resolveNewsContextId", () => {
  it("prefers stateArgs, falls back to runtime, rejects blanks", () => {
    expect(resolveNewsContextId("ctx-a", "ctx-b")).toBe("ctx-a");
    expect(resolveNewsContextId(undefined, "ctx-b")).toBe("ctx-b");
    expect(resolveNewsContextId("  ", undefined)).toBeUndefined();
    expect(resolveNewsContextId(undefined, undefined)).toBeUndefined();
  });
});

describe("name minting", () => {
  it("derives stable prefixed names from the random source", () => {
    expect(newsChannelName(() => "abcdef1234")).toBe("news-abcdef12");
    expect(newsAgentKey(() => "abcdef1234")).toBe("news-agent-abcdef12");
  });
});

describe("deepDivePrompt", () => {
  it("is self-contained: carries title and url", () => {
    const prompt = deepDivePrompt({ title: "Big story", url: "https://example.com/a" });
    expect(prompt).toContain("Big story");
    expect(prompt).toContain("https://example.com/a");
    expect(prompt).toContain("web_fetch");
  });
});
