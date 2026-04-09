/**
 * Resource loader — fetches the system prompt and skill index from the
 * NatStack workspace via RPC.
 *
 * PiRunner uses this at session startup to inject `AGENTS.md` content and
 * a formatted skill index into the agent's system prompt. The skill index
 * is markdown that the LLM can read; actual skill files are fetched on
 * demand by the read tool via `workspace.readSkill`.
 *
 * Pure RPC client — no fs access. The workspace tree (where skills live)
 * is NOT mirrored into per-context fs sandboxes; the resource loader and
 * read-tool routing are the only paths through which skill content is
 * surfaced to the agent.
 *
 * Contract (W1b): `workspace.getAgentsMd` returns the workspace AGENTS.md
 * as a string; `workspace.listSkills` returns an array of `SkillEntry`
 * descriptors (one per skill directory under `workspace/skills/`).
 */

/**
 * Minimal structural type for the RPC caller. Matches `RpcCaller` from
 * `@natstack/types` (which is not a direct dependency of `@natstack/harness`).
 * Any compatible RpcCaller instance can be passed in.
 */
export interface RpcCaller {
  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
}

export interface SkillEntry {
  /** Skill identifier; matches the directory name under `workspace/skills/`. */
  name: string;
  /** Short human-readable description shown in the skill index. */
  description: string;
  /** Absolute path to the skill directory (informational; not used by LLM). */
  dirPath: string;
}

export interface NatStackResources {
  /** Contents of `workspace/AGENTS.md`. */
  systemPrompt: string;
  /** Markdown-formatted skill index suitable for appending to the system prompt. */
  skillIndex: string;
  /** Raw skill descriptors. */
  skills: SkillEntry[];
}

export interface ResourceLoaderDeps {
  rpc: RpcCaller;
}

/**
 * Fetches the workspace system prompt and skill list in parallel and
 * returns a `NatStackResources` bundle for PiRunner to consume.
 */
export async function loadNatStackResources(
  deps: ResourceLoaderDeps,
): Promise<NatStackResources> {
  const [systemPrompt, skills] = await Promise.all([
    deps.rpc.call<string>("main", "workspace.getAgentsMd"),
    deps.rpc.call<SkillEntry[]>("main", "workspace.listSkills"),
  ]);
  const skillIndex = formatSkillIndex(skills);
  return { systemPrompt, skillIndex, skills };
}

/**
 * Renders the skill index as a markdown section. Returns an empty string
 * when there are no skills (so the caller can simply concatenate it with
 * the system prompt without conditional logic).
 */
export function formatSkillIndex(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = ["", "## Available skills", ""];
  for (const s of skills) {
    lines.push(`- **${s.name}** \u2014 ${s.description}`);
  }
  lines.push("");
  lines.push('Use the read tool to load a skill: `read("skills/<name>/SKILL.md")`.');
  lines.push(
    "(The read tool transparently fetches skill files from the workspace via workspace.readSkill \u2014 they live outside the per-context fs sandbox.)",
  );
  return lines.join("\n");
}
