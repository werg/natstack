import { describe, expect, it } from "vitest";
import { resolveHeadlessHostAutospawn } from "./headlessHostAutospawn.js";

describe("resolveHeadlessHostAutospawn", () => {
  it("defaults to enabled so CDP fallback can spawn lazily", () => {
    expect(resolveHeadlessHostAutospawn({})).toBe(true);
  });

  it("lets the CLI flag override the default and environment", () => {
    expect(resolveHeadlessHostAutospawn({ cliValue: false, envValue: "true" })).toBe(false);
    expect(resolveHeadlessHostAutospawn({ cliValue: true, envValue: "0" })).toBe(true);
  });

  it("treats only explicit true environment values as enabled", () => {
    expect(resolveHeadlessHostAutospawn({ envValue: "1" })).toBe(true);
    expect(resolveHeadlessHostAutospawn({ envValue: "true" })).toBe(true);
    expect(resolveHeadlessHostAutospawn({ envValue: "0" })).toBe(false);
    expect(resolveHeadlessHostAutospawn({ envValue: "false" })).toBe(false);
  });
});
