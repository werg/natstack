import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { findBacklinks } from "./BacklinksPanel";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "spectrolite-backlinks-"));
  roots.push(root);
  return root;
}

function writeDoc(root: string, relPath: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
  writeFileSync(path.join(root, relPath), content);
}

describe("findBacklinks", () => {
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it("finds basename, full path, alias, and nested backlinks", async () => {
    const root = makeRoot();
    writeDoc(root, "notes/Target.mdx", "# Target\n");
    writeDoc(root, "ByName.mdx", "See [[Target]].\n");
    writeDoc(root, "ByPath.mdx", "See [[notes/Target]].\n");
    writeDoc(root, "ByAlias.mdx", "See [[Target|read this]].\n");
    writeDoc(root, "Nested/ByNested.mdx", "See [[nested/Target]].\n");
    writeDoc(root, "Nope.mdx", "See [[Other]].\n");

    await expect(
      findBacklinks(root, "notes/Target.mdx", [
        "notes/Target.mdx",
        "ByName.mdx",
        "ByPath.mdx",
        "ByAlias.mdx",
        "Nested/ByNested.mdx",
        "Nope.mdx",
      ])
    ).resolves.toEqual([
      { fromPath: "ByName.mdx", snippet: "See [[Target]]." },
      { fromPath: "ByPath.mdx", snippet: "See [[notes/Target]]." },
      { fromPath: "ByAlias.mdx", snippet: "See [[Target|read this]]." },
      { fromPath: "Nested/ByNested.mdx", snippet: "See [[nested/Target]]." },
    ]);
  });

  it("scans large candidate sets without false positives", async () => {
    const root = makeRoot();
    const paths = ["Target.mdx"];
    writeDoc(root, "Target.mdx", "# Target\n");

    for (let i = 0; i < 1000; i++) {
      const relPath = `bulk/Note-${i}.mdx`;
      paths.push(relPath);
      writeDoc(root, relPath, i % 125 === 0 ? `Link [[Target]] from ${i}\n` : `No target ${i}\n`);
    }

    const backlinks = await findBacklinks(root, "Target.mdx", paths, { concurrency: 32 });
    expect(backlinks.map((link) => link.fromPath)).toEqual([
      "bulk/Note-0.mdx",
      "bulk/Note-125.mdx",
      "bulk/Note-250.mdx",
      "bulk/Note-375.mdx",
      "bulk/Note-500.mdx",
      "bulk/Note-625.mdx",
      "bulk/Note-750.mdx",
      "bulk/Note-875.mdx",
    ]);
  });

  it("preserves candidate order when concurrent reads complete out of order", async () => {
    const root = makeRoot();
    writeDoc(root, "Target.mdx", "# Target\n");
    writeDoc(root, "C.mdx", "See [[Target]].\n");
    writeDoc(root, "A.mdx", "See [[Target]].\n");
    writeDoc(root, "B.mdx", "See [[Target]].\n");

    const backlinks = await findBacklinks(root, "Target.mdx", ["Target.mdx", "C.mdx", "A.mdx", "B.mdx"], { concurrency: 2 });
    expect(backlinks.map((link) => link.fromPath)).toEqual(["C.mdx", "A.mdx", "B.mdx"]);
  });
});
