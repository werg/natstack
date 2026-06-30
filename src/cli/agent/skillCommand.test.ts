import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function jsonOutput(): unknown {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!);
}

describe("natstack agent skill", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-skill-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolveSkillDir finds the repo skill in dev and honors the env override", async () => {
    const { resolveSkillDir } = await import("./skillCommand.js");
    const dev = resolveSkillDir();
    expect(fs.existsSync(path.join(dev, "SKILL.md"))).toBe(true);

    const custom = path.join(tmpDir, "custom-skill");
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, "SKILL.md"), "---\nname: x\n---\n");
    vi.stubEnv("NATSTACK_AGENT_SKILL_DIR", custom);
    expect(resolveSkillDir()).toBe(custom);
  });

  it("install copies the bundled skill into --dir", async () => {
    const source = path.join(tmpDir, "bundle");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "skill body");
    fs.writeFileSync(path.join(source, "EVAL.md"), "eval body");
    vi.stubEnv("NATSTACK_AGENT_SKILL_DIR", source);

    const dest = path.join(tmpDir, "proj", ".claude", "skills", "natstack-agent");
    const { main } = await import("../client.js");
    await expect(main(["agent", "skill", "install", "--dir", dest, "--json"])).resolves.toBe(0);

    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("skill body");
    expect(fs.readFileSync(path.join(dest, "EVAL.md"), "utf8")).toBe("eval body");
    expect(jsonOutput()).toEqual({ installed: dest, files: ["EVAL.md", "SKILL.md"] });
  });

  it("print writes SKILL.md to stdout", async () => {
    const source = path.join(tmpDir, "bundle");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "the skill text\n");
    vi.stubEnv("NATSTACK_AGENT_SKILL_DIR", source);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { main } = await import("../client.js");
    await expect(main(["agent", "skill", "print"])).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith("the skill text\n");
  });

  it("rejects unknown actions with a usage error", async () => {
    const { main } = await import("../client.js");
    await expect(main(["agent", "skill", "bogus", "--json"])).resolves.toBe(2);
  });

  it("the real skill directory ships frontmatter and all referenced files", async () => {
    const { resolveSkillDir } = await import("./skillCommand.js");
    const dir = resolveSkillDir();
    const skillMd = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    expect(skillMd.startsWith("---\nname: natstack-agent\n")).toBe(true);
    expect(skillMd).toMatch(/^description: .*[Uu]se when/m);
    for (const file of ["EVAL.md", "FILES.md", "RECIPES.md", "API.md"]) {
      expect(fs.existsSync(path.join(dir, file)), `${file} missing`).toBe(true);
    }
  });
});
