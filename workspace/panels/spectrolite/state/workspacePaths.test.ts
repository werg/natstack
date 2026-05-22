import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { listMdxPaths } from "./workspacePaths";

describe("listMdxPaths", () => {
  it("returns sorted mdx paths and skips dot directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "spectrolite-paths-"));
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, "Z.mdx"), "# Z");
    await writeFile(join(root, "notes", "A.mdx"), "# A");
    await writeFile(join(root, "notes", "ignore.txt"), "ignore");
    await writeFile(join(root, ".hidden", "Hidden.mdx"), "# Hidden");

    await expect(listMdxPaths(root)).resolves.toEqual(["Z.mdx", "notes/A.mdx"]);
  });

  it("returns an empty list for missing roots", async () => {
    await expect(listMdxPaths("/definitely/not/a/spectrolite/root")).resolves.toEqual([]);
  });

  it("walks broad nested vaults with bounded concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "spectrolite-paths-wide-"));
    for (let i = 0; i < 40; i++) {
      await mkdir(join(root, `area-${i}`, "notes"), { recursive: true });
      await writeFile(join(root, `area-${i}`, "notes", `Doc-${i}.mdx`), `# ${i}`);
      await writeFile(join(root, `area-${i}`, "notes", `Ignore-${i}.txt`), "ignore");
    }

    const paths = await listMdxPaths(root, { concurrency: 4 });
    expect(paths).toHaveLength(40);
    expect(paths[0]).toBe("area-0/notes/Doc-0.mdx");
    expect(paths).toContain("area-39/notes/Doc-39.mdx");
  });
});
