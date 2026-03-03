/**
 * Tool wiring tests — verify that createAllToolMethodDefinitions returns
 * all expected tools with valid schemas and execute functions.
 *
 * Note: These tests mock @workspace/runtime since we're not in a panel context.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock the runtime module
vi.mock("@workspace/runtime", () => ({
  rpc: { call: vi.fn() },
  contextId: "ctx_test",
}));

// Dynamic import after mock setup
let createAllToolMethodDefinitions: typeof import("../index").createAllToolMethodDefinitions;

beforeAll(async () => {
  const mod = await import("../index");
  createAllToolMethodDefinitions = mod.createAllToolMethodDefinitions;
});

describe("createAllToolMethodDefinitions", () => {
  it("returns all expected tool names", () => {
    const tools = createAllToolMethodDefinitions();
    const names = Object.keys(tools);

    expect(names).toContain("check_types");
    expect(names).toContain("get_type_info");
    expect(names).toContain("get_completions");
    expect(names).toContain("git");
    expect(names).toContain("create_project");
    expect(names).toContain("run_tests");
  });

  it("each tool has a valid schema (parameters)", () => {
    const tools = createAllToolMethodDefinitions();

    for (const [name, def] of Object.entries(tools)) {
      expect(def.parameters, `${name} should have parameters`).toBeDefined();
      expect(typeof def.parameters.parse, `${name}.parameters should have .parse()`).toBe(
        "function",
      );
    }
  });

  it("each tool has an execute function", () => {
    const tools = createAllToolMethodDefinitions();

    for (const [name, def] of Object.entries(tools)) {
      expect(typeof def.execute, `${name} should have execute()`).toBe("function");
    }
  });

  it("each tool has a description", () => {
    const tools = createAllToolMethodDefinitions();

    for (const [name, def] of Object.entries(tools)) {
      expect(def.description, `${name} should have a description`).toBeTruthy();
      expect(def.description!.length, `${name} description should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("returns exactly 6 tools", () => {
    const tools = createAllToolMethodDefinitions();
    expect(Object.keys(tools).length).toBe(6);
  });
});
