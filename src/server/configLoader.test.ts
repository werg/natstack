import { describe, expect, it } from "vitest";
import { CONFIG_LOADER_JS } from "./configLoader.js";

describe("CONFIG_LOADER_JS", () => {
  it("requires canonical entityId bootstrap identity without the old panelId alias", () => {
    expect(CONFIG_LOADER_JS).toContain("const entityId = cfg?.entityId;");
    expect(CONFIG_LOADER_JS).not.toContain("cfg?.panelId");
  });
});
