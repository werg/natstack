import { describe, it, expect, vi } from "vitest";
import {
  loadNatStackResources,
  formatSkillIndex,
  type RpcCaller,
  type SkillEntry,
} from "./resource-loader.js";

/**
 * Builds a mock `RpcCaller` whose `call()` returns canned responses keyed
 * by `<targetId>:<method>`. Unknown methods reject so missing routes
 * surface immediately as test failures.
 */
function createMockRpc(responses: Record<string, unknown>): RpcCaller {
  const call = vi.fn(async (targetId: string, method: string) => {
    const key = `${targetId}:${method}`;
    if (!(key in responses)) {
      throw new Error(`Unexpected RPC call: ${key}`);
    }
    return responses[key];
  });
  return { call: call as RpcCaller["call"] };
}

const SAMPLE_SKILLS: SkillEntry[] = [
  {
    name: "eval",
    description: "Evaluate expressions in a sandboxed JS REPL.",
    dirPath: "/workspace/skills/eval",
  },
  {
    name: "search",
    description: "Search the codebase using ripgrep.",
    dirPath: "/workspace/skills/search",
  },
];

describe("loadNatStackResources", () => {
  it("fetches system prompt + skills via workspace.* RPC", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": SAMPLE_SKILLS,
    });
    const callSpy = rpc.call as ReturnType<typeof vi.fn>;

    const resources = await loadNatStackResources({ rpc });

    expect(resources.systemPrompt).toBe("System prompt content");
    expect(resources.skills).toEqual(SAMPLE_SKILLS);
    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(callSpy).toHaveBeenCalledWith("main", "workspace.getAgentsMd");
    expect(callSpy).toHaveBeenCalledWith("main", "workspace.listSkills");
  });

  it("formats skillIndex as a markdown section listing each skill", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": SAMPLE_SKILLS,
    });

    const { skillIndex } = await loadNatStackResources({ rpc });

    expect(skillIndex).toContain("## Available skills");
    expect(skillIndex).toContain(
      "- **eval** \u2014 Evaluate expressions in a sandboxed JS REPL.",
    );
    expect(skillIndex).toContain(
      "- **search** \u2014 Search the codebase using ripgrep.",
    );
    expect(skillIndex).toContain('read("skills/<name>/SKILL.md")');
    expect(skillIndex).toContain("workspace.readSkill");
  });

  it("returns an empty skillIndex when there are no skills", async () => {
    const rpc = createMockRpc({
      "main:workspace.getAgentsMd": "System prompt content",
      "main:workspace.listSkills": [],
    });

    const resources = await loadNatStackResources({ rpc });

    expect(resources.skills).toEqual([]);
    expect(resources.skillIndex).toBe("");
    expect(resources.systemPrompt).toBe("System prompt content");
  });

  it("issues both RPC calls in parallel (does not serialize)", async () => {
    let agentsMdResolve: ((value: string) => void) | undefined;
    let skillsResolve: ((value: SkillEntry[]) => void) | undefined;
    const agentsMdPromise = new Promise<string>((r) => {
      agentsMdResolve = r;
    });
    const skillsPromise = new Promise<SkillEntry[]>((r) => {
      skillsResolve = r;
    });

    const call = vi.fn(async (_targetId: string, method: string) => {
      if (method === "workspace.getAgentsMd") return agentsMdPromise;
      if (method === "workspace.listSkills") return skillsPromise;
      throw new Error(`unexpected method: ${method}`);
    });
    const rpc: RpcCaller = { call: call as RpcCaller["call"] };

    const loadPromise = loadNatStackResources({ rpc });
    // Both calls should be in flight before either resolves.
    expect(call).toHaveBeenCalledTimes(2);

    skillsResolve?.([]);
    agentsMdResolve?.("Prompt");
    const result = await loadPromise;
    expect(result.systemPrompt).toBe("Prompt");
    expect(result.skills).toEqual([]);
  });
});

describe("formatSkillIndex", () => {
  it("returns empty string for empty input", () => {
    expect(formatSkillIndex([])).toBe("");
  });

  it("starts with a leading blank line and the heading", () => {
    const out = formatSkillIndex([
      { name: "x", description: "X skill", dirPath: "/x" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("## Available skills");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("- **x** \u2014 X skill");
  });
});
