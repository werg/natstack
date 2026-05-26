import { describe, expect, it } from "vitest";
import type { PanelArtifacts } from "@natstack/shared/types";
import { shouldShowPanelView } from "./PanelStackVisibility";

describe("shouldShowPanelView", () => {
  it("shows an existing native view while the panel build is still marked building", () => {
    expect(
      shouldShowPanelView({
        htmlPath: "http://localhost:1234/panels/chat/",
        buildState: "building",
      })
    ).toBe(true);
  });

  it.each<PanelArtifacts | undefined>([
    undefined,
    {},
    { buildState: "pending" },
    { htmlPath: "http://localhost:1234/panels/chat/", buildState: "pending" },
    { htmlPath: "http://localhost:1234/panels/chat/", buildState: "error" },
    { htmlPath: "http://localhost:1234/panels/chat/", buildState: "error", error: "failed" },
  ])("does not show a panel without a displayable native view: %j", (artifacts) => {
    expect(shouldShowPanelView(artifacts)).toBe(false);
  });
});
