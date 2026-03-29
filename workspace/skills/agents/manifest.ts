/**
 * Agent manifest loading and discovery.
 *
 * Supports two patterns:
 * 1. Registry file: workspace/agents/agents.yml → array of inline manifests
 * 2. Per-directory: workspace/agents/{name}/agent.yml → individual complex agents
 *
 * Per-directory manifests override registry entries with the same handle.
 */

import { fs } from "@workspace/runtime";
import type { AgentManifest } from "./types.js";

/**
 * Parse a raw YAML-like object into a validated AgentManifest.
 * Accepts either a parsed YAML object or a raw YAML string.
 */
export function loadAgentManifest(input: unknown): AgentManifest {
  const obj = typeof input === "string" ? parseSimpleYaml(input) : input;
  const raw = obj as Record<string, unknown>;

  if (!raw["name"] || typeof raw["name"] !== "string") {
    throw new Error("Agent manifest missing required field: name");
  }
  if (!raw["handle"] || typeof raw["handle"] !== "string") {
    throw new Error("Agent manifest missing required field: handle");
  }
  if (!raw["personality"] || typeof raw["personality"] !== "string") {
    throw new Error("Agent manifest missing required field: personality");
  }

  return {
    name: raw["name"] as string,
    handle: raw["handle"] as string,
    personality: raw["personality"] as string,
    systemPromptMode: raw["systemPromptMode"] as AgentManifest["systemPromptMode"],
    model: raw["model"] as string | undefined,
    temperature: raw["temperature"] as number | undefined,
    maxTokens: raw["maxTokens"] as number | undefined,
    tools: raw["tools"] as string[] | undefined,
    greeting: raw["greeting"] as string | undefined,
    memory: raw["memory"] as AgentManifest["memory"] | undefined,
  };
}

/**
 * Convert a manifest into subscription config that buildHarnessConfig() understands.
 */
export function manifestToSubscriptionConfig(m: AgentManifest): Record<string, unknown> {
  return {
    handle: m.handle,
    name: m.name,
    systemPrompt: m.personality,
    systemPromptMode: m.systemPromptMode ?? "replace-natstack",
    ...(m.model ? { model: m.model } : {}),
    ...(m.temperature != null ? { temperature: m.temperature } : {}),
    ...(m.maxTokens != null ? { maxTokens: m.maxTokens } : {}),
    ...(m.tools ? { toolAllowlist: m.tools } : {}),
    ...(m.greeting ? { greeting: m.greeting } : {}),
    personality: m.personality,
  };
}

/**
 * Discover all agent manifests from workspace/agents/.
 * Scans both the registry file and per-directory manifests.
 */
export async function discoverManifests(): Promise<Map<string, AgentManifest>> {
  const agents = new Map<string, AgentManifest>();

  // 1. Registry file: workspace/agents/agents.yml → array of inline manifests
  try {
    const registryContent = await fs.readFile("agents/agents.yml", "utf-8");
    const parsed = parseSimpleYaml(registryContent);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown>)?.["agents"];
    if (Array.isArray(list)) {
      for (const entry of list) {
        try {
          const manifest = loadAgentManifest(entry);
          agents.set(manifest.handle, manifest);
        } catch (err) {
          console.warn(`[agents] Skipping invalid registry entry:`, err);
        }
      }
    }
  } catch {
    // No registry file — that's fine
  }

  // 2. Per-directory: workspace/agents/*/agent.yml → individual complex agents
  try {
    const entries = await fs.readdir("agents");
    for (const entry of entries) {
      if (entry === "agents.yml") continue;
      try {
        const content = await fs.readFile(`agents/${entry}/agent.yml`, "utf-8");
        const manifest = loadAgentManifest(content);
        agents.set(manifest.handle, manifest); // per-directory overrides registry
      } catch {
        // Not an agent directory — skip
      }
    }
  } catch {
    // No agents directory
  }

  return agents;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser for agent manifests.
// Handles the subset of YAML used in agent.yml files: scalars, lists, maps,
// multi-line strings (| block scalar), and nested objects.
// For full YAML support, import the "yaml" npm package instead.
// ---------------------------------------------------------------------------

function parseSimpleYaml(text: string): unknown {
  const lines = text.split("\n");
  return parseYamlLines(lines, 0, 0).value;
}

function parseYamlLines(
  lines: string[],
  start: number,
  baseIndent: number,
): { value: unknown; nextLine: number } {
  const result: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent < baseIndent) break;

    const trimmed = line.trimStart();

    // Array item at top level — return as array
    if (trimmed.startsWith("- ") && indent === baseIndent) {
      return parseYamlArray(lines, start, baseIndent);
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === "" || rest === "|") {
      // Block scalar or nested object
      const isBlock = rest === "|";
      const nextLine = i + 1;
      if (nextLine < lines.length) {
        const nextIndent = lines[nextLine]!.length - lines[nextLine]!.trimStart().length;
        if (nextIndent > indent) {
          if (isBlock) {
            // Multi-line string
            const blockLines: string[] = [];
            let j = nextLine;
            while (j < lines.length) {
              const bline = lines[j]!;
              if (bline.trim() === "") { blockLines.push(""); j++; continue; }
              const bIndent = bline.length - bline.trimStart().length;
              if (bIndent < nextIndent) break;
              blockLines.push(bline.slice(nextIndent));
              j++;
            }
            // Trim trailing empty lines
            while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
              blockLines.pop();
            }
            result[key] = blockLines.join("\n") + "\n";
            i = j;
          } else {
            // Check if it's an array or nested object
            const nextTrimmed = lines[nextLine]!.trimStart();
            if (nextTrimmed.startsWith("- ")) {
              const sub = parseYamlArray(lines, nextLine, nextIndent);
              result[key] = sub.value;
              i = sub.nextLine;
            } else {
              const sub = parseYamlLines(lines, nextLine, nextIndent);
              result[key] = sub.value;
              i = sub.nextLine;
            }
          }
        } else {
          result[key] = null;
          i++;
        }
      } else {
        result[key] = null;
        i++;
      }
    } else {
      // Inline value
      result[key] = parseYamlValue(rest);
      i++;
    }
  }

  return { value: result, nextLine: i };
}

function parseYamlArray(
  lines: string[],
  start: number,
  baseIndent: number,
): { value: unknown[]; nextLine: number } {
  const items: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) { i++; continue; }

    const indent = line.length - line.trimStart().length;
    if (indent < baseIndent) break;

    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) break;

    const itemContent = trimmed.slice(2);

    // Check if item has nested content (next line is indented further)
    if (itemContent.includes(":")) {
      // Inline map item: "- key: value\n    key2: value2"
      const itemIndent = indent + 2;
      // Reconstruct as if the "- " wasn't there
      const pseudoLines = [" ".repeat(itemIndent) + itemContent];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j]!;
        if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) { pseudoLines.push(nextLine); j++; continue; }
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent < itemIndent) break;
        pseudoLines.push(nextLine);
        j++;
      }
      const sub = parseYamlLines(pseudoLines, 0, itemIndent);
      items.push(sub.value);
      i = j;
    } else {
      // Simple scalar item
      items.push(parseYamlValue(itemContent));
      i++;
    }
  }

  return { value: items, nextLine: i };
}

function parseYamlValue(raw: string): unknown {
  // Inline flow sequence: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw.slice(1, -1).split(",").map(s => parseYamlValue(s.trim()));
  }
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Null
  if (raw === "null" || raw === "~") return null;
  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;
  // Plain string
  return raw;
}
