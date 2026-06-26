import { describe, expect, it } from "vitest";
import { isOpenPanelOperation, panelAccessSeverityForTarget } from "./panelAccessPolicy.js";

describe("panelAccessPolicy", () => {
  it("treats reads / observation / consensual presence as open (ungated)", () => {
    for (const op of ["read", "metadata", "ensureLoaded", "focus"] as const) {
      expect(isOpenPanelOperation(op)).toBe(true);
    }
  });

  it("treats control-plane operations as gated (not open)", () => {
    for (const op of [
      "cdp",
      "openPanel",
      "close",
      "navigate",
      "reload",
      "goBack",
      "goForward",
      "stop",
      "archive",
      "unload",
      "movePanel",
      "replacePanel",
      "takeOver",
      "openDevTools",
      "rebuildPanel",
      "rebuildAndReload",
      "updatePanelState",
      "stateArgs.set",
    ] as const) {
      expect(isOpenPanelOperation(op)).toBe(false);
    }
  });

  it("escalates privileged and shell targets to severe severity", () => {
    expect(panelAccessSeverityForTarget({ id: "about", privileged: true })).toBe("severe");
    expect(panelAccessSeverityForTarget({ id: "about", shell: true })).toBe("severe");
  });

  it("keeps ordinary targets at standard severity", () => {
    expect(panelAccessSeverityForTarget({ id: "panel-b" })).toBe("standard");
    expect(panelAccessSeverityForTarget({ id: "panel-b", privileged: false, shell: false })).toBe(
      "standard"
    );
  });
});
