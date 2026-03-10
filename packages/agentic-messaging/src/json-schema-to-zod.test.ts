import { z } from "zod";
import { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("returns false for null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("jsonSchemaToZod", () => {
  it("converts primitive string type", () => {
    const schema = jsonSchemaToZod({ type: "string" });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it("converts primitive number type", () => {
    const schema = jsonSchemaToZod({ type: "number" });
    expect(schema.safeParse(3.14).success).toBe(true);
    expect(schema.safeParse("not a number").success).toBe(false);
  });

  it("converts integer type to z.number().int()", () => {
    const schema = jsonSchemaToZod({ type: "integer" });
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(3.14).success).toBe(false);
  });

  it("converts boolean type", () => {
    const schema = jsonSchemaToZod({ type: "boolean" });
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse("true").success).toBe(false);
  });

  it("converts null type", () => {
    const schema = jsonSchemaToZod({ type: "null" });
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it("handles nullable variants", () => {
    const schema = jsonSchemaToZod({ type: "string", nullable: true });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it("converts string enum to z.enum", () => {
    const schema = jsonSchemaToZod({ enum: ["red", "green", "blue"] });
    expect(schema.safeParse("red").success).toBe(true);
    expect(schema.safeParse("yellow").success).toBe(false);
  });

  it("converts mixed enum to z.union of literals", () => {
    const schema = jsonSchemaToZod({ enum: ["hello", 42, true] });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse("nope").success).toBe(false);
  });

  it("converts single enum to z.literal", () => {
    const schema = jsonSchemaToZod({ enum: [42] });
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(43).success).toBe(false);
  });

  it("converts array type with items", () => {
    const schema = jsonSchemaToZod({ type: "array", items: { type: "string" } });
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse([1, 2]).success).toBe(false);
    expect(schema.safeParse("not array").success).toBe(false);
  });

  it("converts object with properties and required", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(schema.safeParse({ name: "Alice" }).success).toBe(true);
    expect(schema.safeParse({ name: "Alice", age: 30 }).success).toBe(true);
    expect(schema.safeParse({ age: 30 }).success).toBe(false);
  });

  it("handles additionalProperties: false as strict", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(schema.safeParse({ name: "Alice" }).success).toBe(true);
    expect(schema.safeParse({ name: "Alice", extra: true }).success).toBe(false);
  });

  it("handles additionalProperties: true/undefined as passthrough", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    const result = schema.safeParse({ name: "Alice", extra: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", extra: true });
    }
  });

  it("converts oneOf to z.union", () => {
    const schema = jsonSchemaToZod({
      oneOf: [{ type: "string" }, { type: "number" }],
    });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it("converts anyOf to z.union", () => {
    const schema = jsonSchemaToZod({
      anyOf: [{ type: "string" }, { type: "boolean" }],
    });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it("converts allOf to z.intersection chain", () => {
    const schema = jsonSchemaToZod({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(schema.safeParse({ a: "hello", b: 42 }).success).toBe(true);
    expect(schema.safeParse({ a: "hello" }).success).toBe(false);
  });

  it("converts type union array (e.g., ['string', 'null'])", () => {
    const schema = jsonSchemaToZod({ type: ["string", "null"] });
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(42).success).toBe(false);
  });

  it("returns z.any() for empty/unknown schema", () => {
    const schema = jsonSchemaToZod({});
    expect(schema.safeParse("anything").success).toBe(true);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
  });
});

describe("jsonSchemaToZodRawShape", () => {
  it("converts properties with required/optional distinction", () => {
    const shape = jsonSchemaToZodRawShape({
      properties: {
        name: { type: "string" },
        bio: { type: "string" },
      },
      required: ["name"],
    });
    const schema = z.object(shape);
    expect(schema.safeParse({ name: "Alice" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // name is required
  });
});
