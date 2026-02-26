import { validateStateArgs } from "./stateArgsValidator.js";

describe("validateStateArgs", () => {
  it("rejects non-JSON-serializable input (function)", () => {
    const result = validateStateArgs(() => {}, undefined);
    expect(result).toEqual({ success: false, error: "stateArgs must be JSON-serializable" });
  });

  it("rejects non-JSON-serializable input (circular reference)", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    const result = validateStateArgs(obj, undefined);
    expect(result).toEqual({ success: false, error: "stateArgs must be JSON-serializable" });
  });

  it("accepts any JSON-serializable value when schema is undefined", () => {
    const result = validateStateArgs({ foo: 123, bar: "hello" }, undefined);
    expect(result).toEqual({ success: true, data: { foo: 123, bar: "hello" } });
  });

  it("treats null args as empty object", () => {
    const result = validateStateArgs(null, undefined);
    expect(result).toEqual({ success: true, data: {} });
  });

  it("treats undefined args as empty object", () => {
    const result = validateStateArgs(undefined, undefined);
    expect(result).toEqual({ success: true, data: {} });
  });

  it("validates against schema and accepts valid data", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };
    const result = validateStateArgs({ name: "Alice", age: 30 }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("rejects data that fails schema validation", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    };
    const result = validateStateArgs({}, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("name");
      expect(result.error).toContain("required");
    }
  });

  it("applies defaults from schema", () => {
    const schema = {
      type: "object" as const,
      properties: {
        color: { type: "string", default: "blue" },
      },
    };
    const result = validateStateArgs({}, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ color: "blue" });
    }
  });

  it("coerces types when coerceTypes is enabled (string to number)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        count: { type: "number" },
      },
    };
    const result = validateStateArgs({ count: "42" }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ count: 42 });
    }
  });
});
