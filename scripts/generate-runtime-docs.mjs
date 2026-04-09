import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function valueEntry(description) {
  return { kind: "value", ...(description ? { description } : {}) };
}

function namespaceEntry(members, description) {
  return { kind: "namespace", members, ...(description ? { description } : {}) };
}

function loadRuntimeSurface(relativePath, exportName) {
  const filePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  const compiled = source
    .replace(/^import .*$/gm, "")
    .replace(
      new RegExp(`export const ${exportName}: RuntimeSurface =`),
      "globalThis.__runtimeSurface =",
    );

  const context = {
    globalThis: {},
    valueEntry,
    namespaceEntry,
  };

  vm.runInNewContext(compiled, context, { filename: filePath });
  const runtimeSurface = context.globalThis.__runtimeSurface;
  if (!runtimeSurface || typeof runtimeSurface !== "object") {
    throw new Error(`Failed to load runtime surface from ${relativePath}`);
  }
  return runtimeSurface;
}

function renderSurfaceTable(surface) {
  const lines = [
    `Generated from \`${surface.target === "panel" ? "runtimeSurface.panel.ts" : "runtimeSurface.worker.ts"}\`. Use \`await help()\` at runtime for the live surface.`,
    "",
    "| Export | Kind | Members | Description |",
    "|--------|------|---------|-------------|",
  ];

  for (const [name, entry] of Object.entries(surface.exports)) {
    const members = entry.kind === "namespace"
      ? `\`${entry.members.join("`, `")}\``
      : "";
    const description = entry.description ?? "";
    lines.push(`| \`${name}\` | ${entry.kind} | ${members} | ${description} |`);
  }

  return lines.join("\n");
}

function replaceBlock(contents, marker, replacement) {
  const begin = `<!-- BEGIN GENERATED: ${marker} -->`;
  const end = `<!-- END GENERATED: ${marker} -->`;
  const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (!pattern.test(contents)) {
    throw new Error(`Missing generated block markers for ${marker}`);
  }
  return contents.replace(pattern, `${begin}\n${replacement}\n${end}`);
}

function updateDoc(relativePath, replacements, checkOnly) {
  const filePath = path.join(repoRoot, relativePath);
  const current = fs.readFileSync(filePath, "utf8");
  let next = current;

  for (const [marker, replacement] of replacements) {
    next = replaceBlock(next, marker, replacement);
  }

  if (checkOnly) {
    if (next !== current) {
      throw new Error(`${relativePath} is out of date. Run: pnpm run generate:runtime-docs`);
    }
    return;
  }

  if (next !== current) {
    fs.writeFileSync(filePath, next);
  }
}

const panelSurface = loadRuntimeSurface(
  "workspace/packages/runtime/src/shared/runtimeSurface.panel.ts",
  "panelRuntimeSurface",
);
const workerSurface = loadRuntimeSurface(
  "workspace/packages/runtime/src/shared/runtimeSurface.worker.ts",
  "workerRuntimeSurface",
);

const checkOnly = process.argv.includes("--check");

updateDoc(
  "workspace/skills/sandbox/RUNTIME_API.md",
  [["panel-runtime-surface", renderSurfaceTable(panelSurface)]],
  checkOnly,
);

updateDoc(
  "workspace/skills/paneldev/WORKERS.md",
  [["worker-runtime-surface", renderSurfaceTable(workerSurface)]],
  checkOnly,
);
