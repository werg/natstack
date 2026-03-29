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
 * Each agent is a directory containing an agent.yml manifest.
 */
export async function discoverManifests(): Promise<Map<string, AgentManifest>> {
  const agents = new Map<string, AgentManifest>();

  try {
    const entries = await fs.readdir("agents");
    for (const entry of entries) {
      try {
        const content = await fs.readFile(`agents/${entry}/agent.yml`, "utf-8");
        const manifest = loadAgentManifest(content);
        agents.set(manifest.handle, manifest);
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
// multi-line strings (| and > block scalars), flow sequences [a, b],
// flow mappings {key: value}, and nested objects.
// Does NOT support anchors/aliases, multi-document (---), or merge keys (<<).
// For full YAML support, import the "yaml" npm package instead.
// ---------------------------------------------------------------------------

function parseSimpleYaml(text: string): unknown {
  // Strip document separators
  const cleaned = text.replace(/^---\s*$/gm, "").replace(/^\.\.\.\s*$/gm, "");
  const lines = cleaned.split("\n");
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

    // Key-value pair — find the first colon that's not inside quotes
    const colonIdx = findKeyColon(trimmed);
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest === "" || rest === "|" || rest === ">") {
      // Block scalar or nested object
      const isBlock = rest === "|" || rest === ">";
      const isFolded = rest === ">";
      const nextLine = i + 1;
      // Find next non-empty line to determine indent
      let nextContentLine = nextLine;
      while (nextContentLine < lines.length && lines[nextContentLine]!.trim() === "") {
        nextContentLine++;
      }
      if (nextContentLine < lines.length) {
        const nextIndent = lines[nextContentLine]!.length - lines[nextContentLine]!.trimStart().length;
        if (nextIndent > indent) {
          if (isBlock) {
            // Multi-line string (literal | or folded >)
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
            if (isFolded) {
              // Folded: join lines with spaces, preserve double newlines as paragraph breaks
              result[key] = blockLines.join("\n").replace(/([^\n])\n([^\n])/g, "$1 $2") + "\n";
            } else {
              result[key] = blockLines.join("\n") + "\n";
            }
            i = j;
          } else {
            // Check if it's an array or nested object
            const nextTrimmed = lines[nextContentLine]!.trimStart();
            if (nextTrimmed.startsWith("- ")) {
              const sub = parseYamlArray(lines, nextContentLine, nextIndent);
              result[key] = sub.value;
              i = sub.nextLine;
            } else {
              const sub = parseYamlLines(lines, nextContentLine, nextIndent);
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
    if (itemContent.includes(":") && !itemContent.startsWith("{")) {
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
      // Simple scalar item or flow value
      items.push(parseYamlValue(itemContent));
      i++;
    }
  }

  return { value: items, nextLine: i };
}

/** Find the colon that separates key from value, skipping colons inside quotes. */
function findKeyColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      // Must be followed by space, end-of-string, or newline to be a key separator
      if (i + 1 >= s.length || s[i + 1] === " " || s[i + 1] === "\n") {
        return i;
      }
    }
  }
  return -1;
}

function parseYamlValue(raw: string): unknown {
  // Strip inline comments: "value # comment" → "value"
  const stripped = stripInlineComment(raw);

  // Flow mapping: {key: value, key2: value2}
  if (stripped.startsWith("{") && stripped.endsWith("}")) {
    return parseFlowMapping(stripped);
  }
  // Flow sequence: [a, b, c]
  if (stripped.startsWith("[") && stripped.endsWith("]")) {
    return parseFlowSequence(stripped);
  }
  // Quoted string
  if ((stripped.startsWith('"') && stripped.endsWith('"')) || (stripped.startsWith("'") && stripped.endsWith("'"))) {
    return stripped.slice(1, -1);
  }
  // Boolean
  if (stripped === "true" || stripped === "True" || stripped === "TRUE") return true;
  if (stripped === "false" || stripped === "False" || stripped === "FALSE") return false;
  // Null
  if (stripped === "null" || stripped === "~" || stripped === "Null" || stripped === "NULL") return null;
  // Number
  const num = Number(stripped);
  if (!isNaN(num) && stripped !== "") return num;
  // Plain string
  return stripped;
}

/** Strip inline comment from a value: `hello # world` → `hello` */
function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && i > 0 && raw[i - 1] === " ") {
      return raw.slice(0, i - 1).trimEnd();
    }
  }
  return raw;
}

/** Parse flow sequence: [a, b, c] → ["a", "b", "c"] */
function parseFlowSequence(raw: string): unknown[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlowItems(inner).map(s => parseYamlValue(s.trim()));
}

/** Parse flow mapping: {key: val, key2: val2} → {key: "val", key2: "val2"} */
function parseFlowMapping(raw: string): Record<string, unknown> {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return {};
  const result: Record<string, unknown> = {};
  const items = splitFlowItems(inner);
  for (const item of items) {
    const colonIdx = item.indexOf(":");
    if (colonIdx === -1) continue;
    const key = item.slice(0, colonIdx).trim();
    const val = item.slice(colonIdx + 1).trim();
    result[key] = parseYamlValue(val);
  }
  return result;
}

/** Split flow items by comma, respecting nested [] and {} and quotes. */
function splitFlowItems(s: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        items.push(s.slice(start, i));
        start = i + 1;
      }
    }
  }
  if (start < s.length) items.push(s.slice(start));
  return items;
}
