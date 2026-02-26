/**
 * Tests for panelIdUtils: sanitizePanelIdSegment, generatePanelNonce, computePanelId.
 */

import {
  sanitizePanelIdSegment,
  generatePanelNonce,
  computePanelId,
} from "./panelIdUtils.js";

vi.mock("crypto", () => ({
  randomBytes: vi.fn(() => Buffer.from([0xde, 0xad, 0xbe, 0xef])),
}));

describe("sanitizePanelIdSegment", () => {
  it("returns trimmed segment for valid input", () => {
    expect(sanitizePanelIdSegment("  my-panel  ")).toBe("my-panel");
  });

  it("throws for empty string", () => {
    expect(() => sanitizePanelIdSegment("")).toThrow("Invalid panel identifier segment");
  });

  it("throws for dot segment", () => {
    expect(() => sanitizePanelIdSegment(".")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment containing /", () => {
    expect(() => sanitizePanelIdSegment("a/b")).toThrow("Invalid panel identifier segment");
  });

  it("throws for segment containing backslash", () => {
    expect(() => sanitizePanelIdSegment("a\\b")).toThrow("Invalid panel identifier segment");
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
  it("root panels get tree/{escapedPath}", () => {
    const id = computePanelId({ relativePath: "src/index.ts", isRoot: true });
    expect(id).toBe("tree/src~index.ts");
  });

  it("named children get {parentId}/{name}", () => {
    const id = computePanelId({
      relativePath: "child.ts",
      parent: { id: "tree/parent" },
      requestedId: "my-child",
    });
    expect(id).toBe("tree/parent/my-child");
  });

  it("auto children get {parentId}/{escapedPath}/{nonce}", () => {
    const id = computePanelId({
      relativePath: "sub/file.ts",
      parent: { id: "tree/parent" },
    });
    // nonce is mocked: timestamp-deadbeef
    expect(id).toMatch(/^tree\/parent\/sub~file\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("uses 'tree' as prefix when parent is null", () => {
    const id = computePanelId({
      relativePath: "file.ts",
      parent: null,
    });
    expect(id).toMatch(/^tree\/file\.ts\/[a-z0-9]+-deadbeef$/);
  });

  it("named child with no parent defaults parentPrefix to 'tree'", () => {
    const id = computePanelId({
      relativePath: "file.ts",
      requestedId: "named",
    });
    expect(id).toBe("tree/named");
  });
});
