import { describe, expect, it } from "vitest";

import type { TurnDispatcherRunner } from "./turn-dispatcher.js";

describe("AgentWorkerBase runner contract", () => {
  it("uses the clean AgentHarness-facing dispatcher surface", () => {
    const methods = [
      "subscribe",
      "prompt",
      "steer",
      "continueAgent",
      "abort",
    ] satisfies Array<keyof TurnDispatcherRunner>;

    expect(methods).toEqual(["subscribe", "prompt", "steer", "continueAgent", "abort"]);
  });
});
