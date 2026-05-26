import { describe, expect, it } from "vitest";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "./types.js";

describe("ELECTRON_LOCAL_SERVICE_NAMES", () => {
  it("routes shell event subscriptions to Electron main", () => {
    expect(ELECTRON_LOCAL_SERVICE_NAMES).toContain("events");
  });

  it("routes app-host notifications to Electron main", () => {
    expect(ELECTRON_LOCAL_SERVICE_NAMES).toContain("notification");
  });
});
