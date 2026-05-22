import { describe, expect, it } from "vitest";
import { joinSafe, parentDir } from "./safePath";

describe("joinSafe", () => {
  it("joins relative paths inside the root", () => {
    expect(joinSafe("/projects/default", "notes/Today.mdx")).toBe("/projects/default/notes/Today.mdx");
  });

  it("normalizes duplicate and backslash separators", () => {
    expect(joinSafe("/projects/default/", "notes\\\\Today.mdx")).toBe("/projects/default/notes/Today.mdx");
    expect(joinSafe("/projects/default", "notes//Today.mdx")).toBe("/projects/default/notes/Today.mdx");
  });

  it("rejects relative traversal outside the root", () => {
    expect(joinSafe("/projects/default", "../other/Secrets.mdx")).toBeNull();
  });

  it("allows absolute paths only when they stay inside the root", () => {
    expect(joinSafe("/projects/default", "/projects/default/notes/Today.mdx")).toBe("/projects/default/notes/Today.mdx");
    expect(joinSafe("/projects/default", "/projects/defaultish/Today.mdx")).toBeNull();
  });

  it("resolves dot segments without treating ordinary names as sentinels", () => {
    expect(joinSafe("/projects/default", "a/./b/../__ESCAPE__/c.mdx")).toBe("/projects/default/a/__ESCAPE__/c.mdx");
  });
});

describe("parentDir", () => {
  it("returns the containing directory", () => {
    expect(parentDir("/projects/default/notes/Today.mdx")).toBe("/projects/default/notes");
  });

  it("returns null for root-level paths", () => {
    expect(parentDir("/Today.mdx")).toBeNull();
  });
});
