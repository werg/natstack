/**
 * Generate skills/natstack-agent/API.md — the RPC service reference for the
 * agent CLI — statically from the server service registry.
 *
 * Like scripts/generate-runtime-docs.mjs this runs without a live server:
 * every src/server/services/*Service(Def).ts module is imported (via tsx),
 * its exported `create*` factories are invoked with inert proxy deps (deps
 * are only used inside handler closures), and the resulting
 * ServiceDefinitions are filtered to the ones a `shell` caller — i.e. the
 * paired CLI — is allowed to dispatch to.
 *
 * Usage:
 *   pnpm generate:agent-docs          # rewrite API.md
 *   pnpm generate:agent-docs --check  # fail if API.md is out of date
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const servicesDir = path.join(repoRoot, "src", "server", "services");
const outputPath = path.join(repoRoot, "skills", "natstack-agent", "API.md");

/**
 * An inert stand-in for service deps: every property access, call, and
 * construction yields the same proxy. Factories only close over deps for
 * their handlers, so this satisfies construction without a live server.
 */
function inertDeps() {
  const fn = () => {};
  const proxy = new Proxy(fn, {
    get: (_target, prop) => {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined; // not thenable
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function isServiceDefinition(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    typeof value.handler === "function" &&
    value.methods !== null &&
    typeof value.methods === "object"
  );
}

async function collectServiceDefinitions() {
  const files = fs
    .readdirSync(servicesDir)
    .filter((file) => /Service(Def)?\.ts$/.test(file) && !file.includes(".test."))
    .sort();

  const defs = new Map();
  for (const file of files) {
    const mod = await tsImport(path.join(servicesDir, file), import.meta.url);
    for (const [exportName, exported] of Object.entries(mod)) {
      if (typeof exported !== "function" || !exportName.startsWith("create")) continue;
      let result;
      try {
        result = exported(inertDeps());
        if (result && typeof result.then === "function") result = await result;
      } catch {
        continue; // factory needed real deps at construction time
      }
      for (const candidate of [result, result?.definition]) {
        if (isServiceDefinition(candidate)) defs.set(candidate.name, candidate);
      }
    }
  }
  return [...defs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function shellCallable(def) {
  return Array.isArray(def.policy?.allowed) && def.policy.allowed.includes("shell");
}

function escapeTableCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderService(def) {
  const lines = [`## \`${def.name}\``, ""];
  if (def.description) lines.push(def.description, "");
  lines.push(`Allowed callers: ${def.policy.allowed.map((c) => `\`${c}\``).join(", ")}`, "");
  lines.push("| Method | Description |", "|--------|-------------|");
  for (const [methodName, method] of Object.entries(def.methods)) {
    const shellBlocked =
      Array.isArray(method.policy?.allowed) && !method.policy.allowed.includes("shell");
    if (shellBlocked) continue; // method-level override excludes the CLI
    lines.push(
      `| \`${def.name}.${methodName}\` | ${escapeTableCell(method.description ?? "")} |`
    );
  }
  return lines.join("\n");
}

function renderDoc(defs) {
  return `<!-- GENERATED FILE — do not edit. Regenerate with: pnpm generate:agent-docs -->

# NatStack RPC Service Reference (agent CLI)

Every service below is callable from a paired CLI as
\`natstack agent call SERVICE.METHOD 'ARGS_JSON'\` (and from \`natstack eval run\`
code as \`services.SERVICE.METHOD(...args)\` or \`rpc.call("SERVICE.METHOD", args)\`).

This file lists methods and descriptions only. For full Zod argument and
return schemas of a service, ask the live server:

\`\`\`bash
natstack agent services SERVICE_NAME --json
\`\`\`

Generated statically from \`src/server/services/\`; a server build may register
a subset depending on its configuration — \`natstack agent services\` shows what
is actually live.

Some internal services (e.g. workerd) are not shell-callable and do not appear
here. Create workers and DOs via \`runtime.createEntity\` (\`kind: "worker"\` /
\`"do"\`), then dispatch to them with \`--target\` relay calls.

${defs.map(renderService).join("\n\n")}
`;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const defs = (await collectServiceDefinitions()).filter(shellCallable);
  if (defs.length === 0) throw new Error("no shell-callable service definitions found");
  const next = renderDoc(defs);
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
  if (checkOnly) {
    if (next !== current) {
      throw new Error("skills/natstack-agent/API.md is out of date. Run: pnpm generate:agent-docs");
    }
    return;
  }
  if (next !== current) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, next);
    console.log(`wrote ${path.relative(repoRoot, outputPath)} (${defs.length} services)`);
  } else {
    console.log("API.md up to date");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
