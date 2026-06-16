import { describe, expect, it } from "vitest";
import { normalizeServerEventName } from "./serverConnection.js";

describe("normalizeServerEventName", () => {
  it("strips the EventService transport prefix before HeadlessHost dispatch", () => {
    expect(normalizeServerEventName("event:panel:runtimeLeaseChanged")).toBe(
      "panel:runtimeLeaseChanged"
    );
  });

  it("leaves bare event names unchanged", () => {
    expect(normalizeServerEventName("panel:runtimeLeaseChanged")).toBe(
      "panel:runtimeLeaseChanged"
    );
  });
});
