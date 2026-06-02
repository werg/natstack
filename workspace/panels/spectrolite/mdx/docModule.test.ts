import { describe, expect, it } from "vitest";
import { exportNamesFromSource, hasDocExports } from "./docExports";

describe("doc module export detection", () => {
  it("detects top-level MDX exports", () => {
    const source = [
      "# Demo",
      "",
      "export const Counter = () => null;",
      "export function helper() { return null; }",
    ].join("\n");

    expect(exportNamesFromSource(source)).toEqual(["Counter", "helper"]);
    expect(hasDocExports(source)).toBe(true);
  });

  it("ignores exports inside fenced code examples", () => {
    const source = [
      "# Demo",
      "",
      "```mdx",
      "export const Example = () => <Button />;",
      "<Example />",
      "```",
      "",
      "~~~tsx",
      "export function Other() { return null; }",
      "~~~",
    ].join("\n");

    expect(exportNamesFromSource(source)).toEqual([]);
    expect(hasDocExports(source)).toBe(false);
  });

  it("ignores frontmatter", () => {
    const source = [
      "---",
      "title: export const NotCode = 1",
      "---",
      "",
      "# Body",
    ].join("\n");

    expect(exportNamesFromSource(source)).toEqual([]);
  });
});
