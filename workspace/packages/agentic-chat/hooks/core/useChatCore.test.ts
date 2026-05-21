import { describe, expect, it } from "vitest";

import { shouldAutoSendInitialPrompt, titleFromFirstUserMessage } from "./useChatCore";

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

describe("shouldAutoSendInitialPrompt", () => {
  it("allows a prompt that arrives after the initial render", () => {
    expect(shouldAutoSendInitialPrompt({
      prompt: undefined,
      connected: true,
      alreadySent: false,
      hasPriorMessages: false,
    })).toBe(false);
    expect(shouldAutoSendInitialPrompt({
      prompt: "Read the docs first",
      connected: true,
      alreadySent: false,
      hasPriorMessages: false,
    })).toBe(true);
  });

  it("does not resend after the channel has history or the prompt was sent", () => {
    expect(shouldAutoSendInitialPrompt({
      prompt: "Read the docs first",
      connected: true,
      alreadySent: false,
      hasPriorMessages: true,
    })).toBe(false);
    expect(shouldAutoSendInitialPrompt({
      prompt: "Read the docs first",
      connected: true,
      alreadySent: true,
      hasPriorMessages: false,
    })).toBe(false);
  });
});
