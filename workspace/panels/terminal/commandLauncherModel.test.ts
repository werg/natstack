import { describe, expect, it } from "vitest";
import { commandTargetForEnter, hasCommandTargetModifier } from "./commandLauncherModel.js";

function key(mods: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">> = {}) {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  } as Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey">;
}

describe("command launcher model", () => {
  it("runs Enter in a split-right pane by default", () => {
    expect(commandTargetForEnter(key())).toBe("splitRight");
  });

  it("runs Shift+Enter in a new tab", () => {
    expect(commandTargetForEnter(key({ shiftKey: true }))).toBe("tab");
  });

  it("runs Ctrl/Cmd+Shift+Enter in a split-down pane", () => {
    expect(commandTargetForEnter(key({ ctrlKey: true, shiftKey: true }))).toBe("splitDown");
    expect(commandTargetForEnter(key({ metaKey: true, shiftKey: true }))).toBe("splitDown");
  });

  it("keeps Ctrl/Cmd+Enter on split right", () => {
    expect(commandTargetForEnter(key({ ctrlKey: true }))).toBe("splitRight");
    expect(commandTargetForEnter(key({ metaKey: true }))).toBe("splitRight");
  });

  it("detects whether Enter target modifiers should override suggestion defaults", () => {
    expect(hasCommandTargetModifier(key())).toBe(false);
    expect(hasCommandTargetModifier(key({ shiftKey: true }))).toBe(true);
    expect(hasCommandTargetModifier(key({ ctrlKey: true }))).toBe(true);
    expect(hasCommandTargetModifier(key({ metaKey: true }))).toBe(true);
  });
});
