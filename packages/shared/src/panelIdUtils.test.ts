/**
 * Tests for panelIdUtils: sanitizePanelIdSegment, generatePanelNonce, computePanelId.
 */

import { sanitizePanelIdSegment, generatePanelNonce, computePanelId } from "./panelIdUtils.js";

vi.mock("crypto", () => ({
  randomBytes: vi.fn(() => Buffer.from([0xde, 0xad, 0xbe, 0xef])),
}));

describe("sanitizePanelIdSegment", () => {
  // --- valid inputs ---
  it("returns trimmed segment for valid input", () => {
    expect(sanitizePanelIdSegment("  my-panel  ")).toBe("my-panel");
  });

  it("allows alphanumeric-only segment", () => {
    expect(sanitizePanelIdSegment("foo")).toBe("foo");
  });

  it("allows segment with hyphens and underscores", () => {
    expect(sanitizePanelIdSegment("foo-bar_baz")).toBe("foo-bar_baz");
  });

  it("allows tilde in segment (used by system for about-panel names)", () => {
    // About-panels generate segments of the form `<page>~<timestamp36>`, e.g. "new~lk2f8g"
    expect(sanitizePanelIdSegment("new~lk2f8g")).toBe("new~lk2f8g");
  });

  // --- invalid inputs: path-traversal and shape-violation cases ---
  it("throws for empty string", () => {
    expect(() => sanitizePanelIdSegment("")).toThrow("Invalid panel identifier segment");
  });

  it("throws for dot segment (.)", () => {
    expect(() => sanitizePanelIdSegment(".")).toThrow("Invalid panel identifier segment");
  });

  it("throws for double-dot segment (..) [C3: path-traversal fix]", () => {
    // Previously allowed by the deny-list; now rejected by the allow-list.
    expect(() => sanitizePanelIdSegment("..")).toThrow("Invalid panel identifier segment");
  });

  it("throws for triple-dot segment (...)", () => {
    expect(() => sanitizePanelIdSegment("...")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment containing / (path separator)", () => {
    expect(() => sanitizePanelIdSegment("a/b")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment containing backslash", () => {
    expect(() => sanitizePanelIdSegment("a\\b")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment with leading hyphen", () => {
    expect(() => sanitizePanelIdSegment("-foo")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment with leading underscore", () => {
    expect(() => sanitizePanelIdSegment("_foo")).toThrow("Invalid panel identifier segment");
  });
});

describe("generatePanelNonce", () => {
  it("returns string in timestamp-hex format", () => {
    const nonce = generatePanelNonce();
    // With mocked randomBytes returning deadbeef, the hex portion is "deadbeef"
    expect(nonce).toMatch(/^[a-z0-9]+-deadbeef$/);
  });
});

describe("computePanelId", () => {
  it("root panels get panel:tree/{escapedPath}/{nonce}", () => {
    const id = computePanelId({ relativePath: "src/index.ts", isRoot: true });
    expect(id).toMatch(/^panel:tree\/src~index\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("named children get {parentId}/{name}", () => {
    const id = computePanelId({
      relativePath: "child.ts",
      parent: { id: "panel:tree/parent" },
      requestedId: "my-child",
    });
    expect(id).toBe("panel:tree/parent/my-child");
  });

  it("auto children get {parentId}/{escapedPath}/{nonce}", () => {
    const id = computePanelId({
      relativePath: "sub/file.ts",
      parent: { id: "panel:tree/parent" },
    });
    // nonce is mocked: timestamp-deadbeef
    expect(id).toMatch(/^panel:tree\/parent\/sub~file\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("uses 'panel:tree' as prefix when parent is null", () => {
    const id = computePanelId({
      relativePath: "file.ts",
      parent: null,
    });
    expect(id).toMatch(/^panel:tree\/file\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("named child with no parent defaults parentPrefix to 'panel:tree'", () => {
    const id = computePanelId({
      relativePath: "file.ts",
      requestedId: "named",
    });
    expect(id).toBe("panel:tree/named");
  });
});
