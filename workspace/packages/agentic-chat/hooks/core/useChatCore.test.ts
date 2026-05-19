import { describe, expect, it } from "vitest";

import { titleFromFirstUserMessage } from "./useChatCore";

describe("titleFromFirstUserMessage", () => {
  it("uses the first message text as the default title", () => {
    expect(titleFromFirstUserMessage("Build me a todo app")).toBe("Build me a todo app");
  });

  it("normalizes whitespace", () => {
    expect(titleFromFirstUserMessage("  Build\n\nme\t\ta todo app  ")).toBe(
      "Build me a todo app"
    );
  });

  it("truncates long messages", () => {
    expect(
      titleFromFirstUserMessage(
        "Summarize this repository and identify the most important architectural risks"
      )
    ).toBe("Summarize this repository and identify the most important arc...");
  });

  it("ignores empty text", () => {
    expect(titleFromFirstUserMessage("   ")).toBeNull();
  });
});
