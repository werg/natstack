/**
 * Tests for effectiveVersion.ts — git-based functions with mocked child_process.
 */

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../../main/envPaths.js", () => ({
  getUserDataPath: vi.fn().mockReturnValue("/tmp/test-ev"),
}));

import { execFileSync } from "child_process";
import {
  resolveMainRef,
  computeGitTreeHash,
  getCommitAt,
  diffEvMaps,
} from "./effectiveVersion.js";

describe("effectiveVersion", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  // -------------------------------------------------------------------------
  // resolveMainRef
  // -------------------------------------------------------------------------
  describe("resolveMainRef", () => {
    it("returns refs/heads/main when git rev-parse succeeds for main", () => {
      vi.mocked(execFileSync).mockReturnValue("deadbeef\n");

      // Use a unique repo path to avoid the internal cache
      const ref = resolveMainRef("/repo/resolve-main-success");
      expect(ref).toBe("refs/heads/main");
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--verify", "refs/heads/main"],
        expect.objectContaining({ cwd: "/repo/resolve-main-success" }),
      );
    });

    it("falls back to refs/heads/master when main fails", () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error("not found");
        })
        .mockReturnValueOnce("abcd1234\n");

      const ref = resolveMainRef("/repo/resolve-fallback-master");
      expect(ref).toBe("refs/heads/master");
    });

    it("throws when both main and master fail", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("not found");
      });

      expect(() => resolveMainRef("/repo/resolve-both-fail")).toThrowError(
        /No main\/master branch found/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // computeGitTreeHash
  // -------------------------------------------------------------------------
  describe("computeGitTreeHash", () => {
    it("returns trimmed git rev-parse output for tree ref", () => {
      // First call resolves the main ref, second returns the tree hash
      vi.mocked(execFileSync)
        .mockReturnValueOnce("ok\n") // rev-parse --verify refs/heads/main
        .mockReturnValueOnce("aabbccdd1122334455667788aabbccdd11223344\n"); // rev-parse refs/heads/main^{tree}

      const hash = computeGitTreeHash("/repo/tree-hash-test");
      expect(hash).toBe("aabbccdd1122334455667788aabbccdd11223344");
    });

    it("uses an explicit ref when provided", () => {
      vi.mocked(execFileSync).mockReturnValue("abc123def456\n");

      const hash = computeGitTreeHash("/repo/tree-explicit-ref", "refs/heads/feature");
      expect(execFileSync).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "refs/heads/feature^{tree}"],
        expect.anything(),
      );
      expect(hash).toBe("abc123def456");
    });
  });

  // -------------------------------------------------------------------------
  // getCommitAt
  // -------------------------------------------------------------------------
  describe("getCommitAt", () => {
    it("returns trimmed SHA on success", () => {
      // First call resolves the main ref
      vi.mocked(execFileSync)
        .mockReturnValueOnce("ok\n") // rev-parse --verify refs/heads/main
        .mockReturnValueOnce("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n"); // rev-parse refs/heads/main

      const sha = getCommitAt("/repo/commit-at-success");
      expect(sha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    });

    it("returns null when git command fails", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("not found");
      });

      const sha = getCommitAt("/repo/commit-at-fail", "refs/heads/nonexistent");
      expect(sha).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // diffEvMaps (pure function, no git needed)
  // -------------------------------------------------------------------------
  describe("diffEvMaps", () => {
    it("detects changed, added, and removed entries", () => {
      const previous = { a: "hash1", b: "hash2", c: "hash3" };
      const current = { a: "hash1", b: "hash2-changed", d: "hash4" };

      const result = diffEvMaps(previous, current);
      expect(result.changed).toEqual(["b"]);
      expect(result.added).toEqual(["d"]);
      expect(result.removed).toEqual(["c"]);
    });

    it("returns empty arrays when maps are identical", () => {
      const map = { x: "h1", y: "h2" };
      const result = diffEvMaps(map, { ...map });
      expect(result.changed).toEqual([]);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
    });
  });
});
