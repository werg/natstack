import { describe, expect, it } from "vitest";
import { composeSystemPrompt, NATSTACK_BASE_SYSTEM_PROMPT } from "./system-prompt.js";

describe("composeSystemPrompt", () => {
  it("appends NatStack, workspace, skills, and channel prompts by default", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      systemPrompt: "CHANNEL",
    });

    expect(prompt).toContain(NATSTACK_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf(NATSTACK_BASE_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf("WORKSPACE"));
    expect(prompt.indexOf("WORKSPACE")).toBeLessThan(prompt.indexOf("SKILLS"));
    expect(prompt.indexOf("SKILLS")).toBeLessThan(prompt.indexOf("CHANNEL"));
  });

  it("lets a channel prompt replace the NatStack base while preserving workspace resources", () => {
    const prompt = composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      systemPrompt: "CHANNEL",
      systemPromptMode: "replace-natstack",
    });

    expect(prompt).not.toContain(NATSTACK_BASE_SYSTEM_PROMPT);
    expect(prompt.indexOf("CHANNEL")).toBeLessThan(prompt.indexOf("WORKSPACE"));
    expect(prompt.indexOf("WORKSPACE")).toBeLessThan(prompt.indexOf("SKILLS"));
  });

  it("lets a channel prompt replace the full prompt", () => {
    expect(composeSystemPrompt({
      workspacePrompt: "WORKSPACE",
      skillIndex: "SKILLS",
      systemPrompt: "CHANNEL",
      systemPromptMode: "replace",
    })).toBe("CHANNEL");
  });

  it("keeps NatStack rich-message and browser-open guidance in the base prompt", () => {
    expect(NATSTACK_BASE_SYSTEM_PROMPT).toContain("MDX supports standard Markdown");
    expect(NATSTACK_BASE_SYSTEM_PROMPT).toContain("Callout.Root");
    expect(NATSTACK_BASE_SYSTEM_PROMPT).toContain("<ActionButton message=");
    expect(NATSTACK_BASE_SYSTEM_PROMPT).toContain("openExternal(url)");
  });
});
