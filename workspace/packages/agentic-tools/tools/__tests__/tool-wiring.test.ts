/**
 * Tool wiring tests — verify that agentic-tools exports only eval
 * after removing dedicated tool wrappers.
 */

import { describe, it, expect } from "vitest";

describe("agentic-tools exports", () => {
  it("exports eval tool functions and constants", async () => {
    const mod = await import("../../index");

    expect(typeof mod.executeEvalTool).toBe("function");
    expect(typeof mod.EVAL_DEFAULT_TIMEOUT_MS).toBe("number");
    expect(typeof mod.EVAL_MAX_TIMEOUT_MS).toBe("number");
    expect(typeof mod.EVAL_FRAMEWORK_TIMEOUT_MS).toBe("number");
  });

  it("does not export removed tool functions", async () => {
    const mod: Record<string, unknown> = await import("../../index");

    expect(mod["createAllToolMethodDefinitions"]).toBeUndefined();
    expect(mod["createTypeCheckToolMethodDefinitions"]).toBeUndefined();
    expect(mod["createGitToolMethodDefinitions"]).toBeUndefined();
    expect(mod["createProjectToolMethodDefinitions"]).toBeUndefined();
    expect(mod["createTestToolMethodDefinitions"]).toBeUndefined();
  });
});
