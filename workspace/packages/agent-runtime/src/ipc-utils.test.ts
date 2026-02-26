import { isHostToAgentMessage } from "./ipc-utils.js";

describe("isHostToAgentMessage", () => {
  it('returns true for {type: "init"} messages', () => {
    expect(isHostToAgentMessage({ type: "init" })).toBe(true);
  });

  it('returns true for {type: "shutdown"} messages', () => {
    expect(isHostToAgentMessage({ type: "shutdown" })).toBe(true);
  });

  it('returns true for {type: "state-response"} messages', () => {
    expect(isHostToAgentMessage({ type: "state-response" })).toBe(true);
  });

  it("returns false for non-object and null values", () => {
    expect(isHostToAgentMessage(null)).toBe(false);
    expect(isHostToAgentMessage(undefined)).toBe(false);
    expect(isHostToAgentMessage("init")).toBe(false);
    expect(isHostToAgentMessage(42)).toBe(false);
  });

  it("returns false for objects without a valid type", () => {
    expect(isHostToAgentMessage({})).toBe(false);
    expect(isHostToAgentMessage({ type: "unknown" })).toBe(false);
    expect(isHostToAgentMessage({ type: 123 })).toBe(false);
    expect(isHostToAgentMessage({ foo: "bar" })).toBe(false);
  });
});
