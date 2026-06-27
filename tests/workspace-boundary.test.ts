import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.join(repoRoot, "workspace");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("workspace boundary", () => {
  it("keeps workspace files from reaching back into host repo source", () => {
    const offenders = walk(workspaceRoot)
      .filter((file) => /\.(c?m?[jt]sx?|json|md|ya?ml)$/.test(file))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8");
        const matches = text.match(/\.\.\/\.\.\/\.\.\/(?:tsconfig|packages|apps)[^"]*/g) ?? [];
        return matches.map((match) => `${path.relative(repoRoot, file)} -> ${match}`);
      });

    expect(offenders).toEqual([]);
  });
});
