import { describe, expect, it } from "vitest";
import { diffDependencies, isStateOnlyChange, parseFrontmatter, replaceFrontmatterState, statesEqual } from "./frontmatter";

describe("frontmatter parsing", () => {
  it("parses title, dependencies, and state", () => {
    const parsed = parseFrontmatter([
      "---",
      "title: Example",
      "dependencies:",
      "  lodash: npm:^4.17.21",
      "state:",
      "  count: 3",
      "---",
      "",
      "# Body",
    ].join("\n"));

    expect(parsed.title).toBe("Example");
    expect(parsed.dependencies).toEqual({ lodash: "npm:^4.17.21" });
    expect(parsed.state).toEqual({ count: 3 });
  });

  it("keeps malformed frontmatter conservative", () => {
    const parsed = parseFrontmatter("---\n: bad\n---\nBody");
    expect(parsed.title).toBeNull();
    expect(parsed.dependencies).toEqual({});
    expect(parsed.state).toEqual({});
    expect(parsed.raw).toBe(": bad");
  });
});

describe("frontmatter state replacement", () => {
  it("adds state to an existing frontmatter block without dropping other fields", () => {
    const next = replaceFrontmatterState("---\ntitle: Example\n---\n\nBody", { count: 4 });
    expect(next).toContain("title: Example");
    expect(next).toContain("state:\n  count: 4");
    expect(next).toContain("Body");
  });

  it("prepends frontmatter when state is added to a plain document", () => {
    expect(replaceFrontmatterState("# Body\n", { open: true })).toBe("---\nstate:\n  open: true\n---\n\n# Body\n");
  });

  it("drops state when the state map is empty", () => {
    expect(replaceFrontmatterState("---\ntitle: Example\nstate:\n  count: 1\n---\n\nBody", {})).toBe("---\ntitle: Example\n---\n\nBody");
  });
});

describe("frontmatter comparisons", () => {
  it("recognizes state-only changes", () => {
    const before = "---\ntitle: Example\nstate:\n  count: 1\n---\n\nBody";
    const after = "---\nstate:\n  count: 2\ntitle: Example\n---\n\nBody";
    expect(isStateOnlyChange(before, after)).toBe(true);
  });

  it("does not treat body changes as state-only", () => {
    expect(isStateOnlyChange("---\nstate:\n  x: 1\n---\n\nA", "---\nstate:\n  x: 2\n---\n\nB")).toBe(false);
  });

  it("diffs dependency maps", () => {
    expect(diffDependencies({ a: "1", b: "1" }, { b: "2", c: "1" })).toEqual({
      added: { c: "1" },
      changed: { b: "2" },
      removed: ["a"],
    });
  });

  it("deep-compares state maps", () => {
    expect(statesEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(statesEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
});
