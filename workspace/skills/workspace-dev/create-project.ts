import { fs, vcs } from "@workspace/runtime";

// ---------------------------------------------------------------------------
// commitWorkspace — workspace-dev convenience wrapper around the vcs commit API
// ---------------------------------------------------------------------------

/**
 * Commit the working tree as a workspace transition (GAD-native vcs).
 * The `dir` argument scopes the build-events pointer (e.g. "panels/my-app").
 */
export async function commitWorkspace(
  dir: string,
  message: string
): Promise<string> {
  const result = await vcs.commit(dir, message);
  return result.message;
}

/** Write a set of project files (creating parent directories). */
async function writeProjectFiles(
  dir: string,
  files: Record<string, string | Uint8Array>
): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = `${dir}/${filePath}`;
    const parentDir = fullPath.split("/").slice(0, -1).join("/");
    if (parentDir && parentDir !== dir) {
      await fs.mkdir(parentDir, { recursive: true });
    }
    await fs.writeFile(fullPath, content);
  }
}

const TYPE_DIRS: Record<string, string> = {
  panel: "panels",
  package: "packages",
  skill: "skills",
  agent: "agents",
  worker: "workers",
};

const PACKAGE_SCOPES: Record<string, string> = {
  panel: "@workspace-panels",
  package: "@workspace",
  skill: "@workspace-skills",
  agent: "@workspace-agents",
  worker: "@workspace-workers",
};

function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

export async function createProject(params: {
  projectType: string;
  name: string;
  title?: string;
  template?: string;
}): Promise<{ created: string; files: string[] }> {
  const { projectType, name, title = name, template } = params;

  const typeDir = TYPE_DIRS[projectType];
  if (!typeDir)
    throw new Error(
      `Unknown project type: ${projectType}. Must be one of: panel, package, skill, agent, worker`
    );

  const scope = PACKAGE_SCOPES[projectType];
  const projectPath = `${typeDir}/${name}`;

  // Check if already exists
  if (await fs.exists(projectPath)) {
    throw new Error(`Project already exists: ${projectPath}`);
  }

  // Generate template files
  const files: Record<string, string> = {};

  switch (projectType) {
    case "panel": {
      // Resolve template — defaults to "default" (React+Radix)
      const panelTemplate = template ?? "default";
      let panelFramework = "react";

      // Read template.json from workspace to determine framework
      if (panelTemplate !== "default") {
        const templateConfigPath = `templates/${panelTemplate}/template.json`;
        if (!(await fs.exists(templateConfigPath))) {
          throw new Error(
            `Template "${panelTemplate}" not found. Check workspace/templates/ for available templates.`
          );
        }
        const templateConfig = JSON.parse(
          (await fs.readFile(templateConfigPath, "utf-8")) as string
        );
        if (templateConfig.framework) panelFramework = templateConfig.framework;
      } else {
        try {
          const templateConfig = JSON.parse(
            (await fs.readFile(`templates/default/template.json`, "utf-8")) as string
          );
          if (templateConfig.framework) panelFramework = templateConfig.framework;
        } catch {
          // Default template missing — use React defaults
        }
      }

      if (panelFramework === "svelte") {
        files["package.json"] = JSON.stringify(
          {
            name: `${scope}/${name}`,
            version: "0.1.0",
            private: true,
            type: "module",
            natstack: {
              title,
              ...(panelTemplate !== "default" ? { template: panelTemplate } : {}),
            },
            dependencies: {
              "@workspace/runtime": "workspace:*",
              "@workspace/svelte": "workspace:*",
              svelte: "^5.0.0",
            },
          },
          null,
          2
        );
        files["index.ts"] = `export { default } from "./App.svelte";\n`;
        files["App.svelte"] = `<script>
  import { theme } from "@workspace/svelte";
  import { onMount } from "svelte";

  let mode = window.__natstackAgentMode ?? "live";
  const data = {
    fixture: "${title} fixture data",
    live: "${title} live data",
  };

  onMount(() => {
    const handler = (event) => { mode = event.detail; };
    window.addEventListener("natstack:agentModeChanged", handler);
    return () => window.removeEventListener("natstack:agentModeChanged", handler);
  });
</script>

<div class="container" class:dark={$theme === "dark"}>
  <h1>${title}</h1>
  <p>{data[mode]}</p>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-family: system-ui, sans-serif;
  }
</style>
`;
      } else {
        // Default: React + Radix
        files["package.json"] = JSON.stringify(
          {
            name: `${scope}/${name}`,
            version: "0.1.0",
            private: true,
            type: "module",
            natstack: {
              title,
              ...(panelTemplate !== "default" ? { template: panelTemplate } : {}),
            },
            dependencies: {
              "@workspace/runtime": "workspace:*",
              "@workspace/react": "workspace:*",
              "@radix-ui/themes": "^3.2.1",
            },
          },
          null,
          2
        );
        files["index.tsx"] =
          `import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePanelTheme } from "@workspace/react";
import { Flex, Text, Theme } from "@radix-ui/themes";

type DataMode = "fixture" | "live";
const DataModeContext = createContext<{ mode: DataMode; message: string }>({
  mode: "live",
  message: "${title} live data",
});

function DataModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DataMode>(() =>
    (window as Window & { __natstackAgentMode?: DataMode }).__natstackAgentMode ?? "live"
  );
  useEffect(() => {
    const handler = (event: Event) => setMode((event as CustomEvent<DataMode>).detail);
    window.addEventListener("natstack:agentModeChanged", handler);
    return () => window.removeEventListener("natstack:agentModeChanged", handler);
  }, []);
  const value = useMemo(() => ({
    mode,
    message: mode === "fixture" ? "${title} fixture data" : "${title} live data",
  }), [mode]);
  return <DataModeContext.Provider value={value}>{children}</DataModeContext.Provider>;
}

export default function ${toPascalCase(name)}() {
  const theme = usePanelTheme();
  const content = <${toPascalCase(name)}Content />;

  return (
    <Theme appearance={theme}>
      <DataModeProvider>
        {content}
      </DataModeProvider>
    </Theme>
  );
}

function ${toPascalCase(name)}Content() {
  const data = useContext(DataModeContext);
  return (
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh" }}>
        <Text size="5">${title}</Text>
        <Text size="2" color="gray">{data.message}</Text>
      </Flex>
  );
}
`;
      }
      break;
    }

    case "package":
      files["package.json"] = JSON.stringify(
        {
          name: `${scope}/${name}`,
          version: "0.1.0",
          private: true,
          type: "module",
          exports: { ".": "./index.ts" },
        },
        null,
        2
      );
      files["index.ts"] = `/**\n * ${title}\n */\n\nexport {};\n`;
      break;

    case "skill":
      files["package.json"] = JSON.stringify(
        {
          name: `${scope}/${name}`,
          version: "0.1.0",
          private: true,
          type: "module",
          exports: { ".": "./index.ts" },
          dependencies: { "@workspace/runtime": "workspace:*" },
        },
        null,
        2
      );
      files["index.ts"] = `/**\n * ${title}\n */\n\nexport {};\n`;
      files["SKILL.md"] = `---\nname: ${name}\ndescription: ${title}\n---\n\n# ${title}\n`;
      break;

    case "agent":
      files["package.json"] = JSON.stringify(
        {
          name: `${scope}/${name}`,
          version: "0.1.0",
          natstack: { type: "agent", title },
        },
        null,
        2
      );
      files["index.ts"] = `/**\n * ${title} agent\n */\n\nconsole.log("${title} agent started");\n`;
      break;

    case "worker":
      if (template === "agentic") {
        // Agentic worker template — DO extending AgentWorkerBase
        const className = toPascalCase(name) + "Worker";
        const workerFileName = `${name}-worker`;

        files["package.json"] = JSON.stringify(
          {
            name: `${scope}/${name}`,
            version: "0.1.0",
            private: true,
            type: "module",
            natstack: {
              type: "worker",
              entry: "index.ts",
              durable: {
                classes: [{ className }],
              },
            },
            dependencies: {
              "@workspace/runtime": "workspace:*",
              "@workspace/agentic-do": "workspace:*",
              "@workspace/harness": "workspace:*",
            },
          },
          null,
          2
        );

        files["index.ts"] = `export { ${className} } from "./${workerFileName}.js";
export default { fetch(_req: Request) { return new Response("${name} DO service"); } };
`;

        files[`${workerFileName}.ts`] = `import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@workspace/harness";

/**
 * ${className} — Pi-native agent DO.
 *
 * Pi (\`@earendil-works/pi-agent-core\`) runs in-process. The base class
 * handles channel subscriptions, the channel event pipeline, the per-channel
 * PiRunner lifecycle, and publishes durable agentic trajectory events to the
 * channel transcript. You only need to override the small set of customization
 * hooks below.
 *
 * The system prompt is composed from the NatStack base prompt,
 * workspace/meta/AGENTS.md, the generated skill index, and optional channel
 * prompt config.
 */
export class ${className} extends AgentWorkerBase {
  static override schemaVersion = 1;

  // --- Hook: default model id (provider:model format) ---
  // protected override getDefaultModel(): string {
  //   return "openai-codex:gpt-5.5";
  // }

  // --- Hook: default thinking level ---
  // protected override getDefaultThinkingLevel() {
  //   return "medium" as const;
  // }

  // --- Hook: participant identity ---
  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: "${name}",
      name: "${title}",
      type: "agent",
      methods: [],
    };
  }

  // The base class's onChannelEvent handles incoming messages by forwarding
  // them to the per-channel PiRunner. Override only if you need custom routing.
}
`;

        files[`${workerFileName}.test.ts`] = `import { describe, it, expect } from "vitest";
import type { ChannelEvent } from "@workspace/harness";
import { createTestDO } from "@workspace/runtime/worker";
import { ${className} } from "./${workerFileName}.js";

function makeEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    id: 1,
    messageId: "msg-1",
    type: "message",
    payload: { content: "Hello" },
    senderId: "user-1",
    senderMetadata: { type: "panel" },
    ts: Date.now(),
    persist: true,
    ...overrides,
  };
}

describe("${className}", () => {
  it("constructs without errors", async () => {
    const { instance } = await createTestDO(${className});
    expect(instance).toBeTruthy();
  });

  it("filters non-panel events via shouldProcess", async () => {
    const { instance } = await createTestDO(${className});
    // Non-panel events are filtered by the base class — onChannelEvent is a no-op
    await instance.onChannelEvent("ch-1", makeEvent({ senderMetadata: { type: "agent" } }));
  });
});
`;
      } else {
        // Default stateless worker template
        files["package.json"] = JSON.stringify(
          {
            name: `${scope}/${name}`,
            version: "0.1.0",
            private: true,
            type: "module",
            natstack: { type: "worker", entry: "index.ts", title },
            dependencies: { "@workspace/runtime": "workspace:*" },
          },
          null,
          2
        );
        files["index.ts"] = `import { createWorkerRuntime } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    return new Response("Hello from ${title}!");
  },
};
`;
      }
      break;
  }

  // Write the scaffold and commit it as a workspace transition.
  await writeProjectFiles(projectPath, files);
  await vcs.commit(projectPath, `Create ${projectType}: ${title}`);

  return { created: projectPath, files: Object.keys(files) };
}

const COPY_SKIP_DIRS = new Set([".git", "node_modules", ".cache", ".databases", "dist", "build"]);

export interface ForkProjectOptions {
  from: string;
  to: string;
  title?: string;
  projectType?: "panel" | "worker" | "package" | "skill" | "agent";
  dryRun?: boolean;
  rewrite?:
    | boolean
    | {
        packageName?: boolean;
        title?: boolean;
        reactComponentNames?: boolean;
        workerClassNames?: boolean;
        tests?: boolean;
      };
  classMap?: Record<string, string>;
  commitMessage?: string;
}

export interface ForkProjectResult {
  source: string;
  created: string;
  files: string[];
  rewrites: Array<{ file: string; description: string }>;
  warnings: string[];
  committed: boolean;
  dryRun: boolean;
}

function rewriteEnabled(
  options: ForkProjectOptions,
  key: "packageName" | "title" | "reactComponentNames" | "workerClassNames" | "tests"
): boolean {
  if (options.rewrite === false) return false;
  if (typeof options.rewrite === "object" && key in options.rewrite)
    return options.rewrite[key] !== false;
  return true;
}

function projectNameFromPath(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function projectTypeFromPath(p: string): string | null {
  return (
    Object.entries(TYPE_DIRS).find(([, dir]) => p === dir || p.startsWith(`${dir}/`))?.[0] ?? null
  );
}

function rewriteRelPath(
  rel: string,
  oldName: string,
  newName: string,
  projectType: string | null
): string {
  if (projectType === "worker" && rel.includes(oldName)) return rel.split(oldName).join(newName);
  return rel;
}

async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = (await fs.readdir(prefix ? `${dir}/${prefix}` : dir, {
    withFileTypes: true,
  })) as Array<{ name: string; _isDirectory?: boolean; isDirectory?: () => boolean }>;
  for (const entry of entries) {
    if (COPY_SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDir =
      typeof entry.isDirectory === "function" ? entry.isDirectory() : entry._isDirectory;
    if (isDir) out.push(...(await listFilesRecursive(dir, rel)));
    else out.push(rel);
  }
  return out;
}

function isProbablyTextFile(file: string): boolean {
  return (
    /\.(tsx?|jsx?|json|md|mdx|svelte|css|scss|html|ya?ml|toml|txt)$/i.test(file) ||
    !file.includes(".")
  );
}

async function readText(path: string): Promise<string> {
  return (await fs.readFile(path, "utf-8")) as string;
}

export async function forkProject(options: ForkProjectOptions): Promise<ForkProjectResult> {
  const from = options.from.replace(/^\/+|\/+$/g, "");
  const to = options.to.replace(/^\/+|\/+$/g, "");
  if (!from || !to) throw new Error("forkProject requires from and to paths");
  if (!(await fs.exists(from))) throw new Error(`Source project does not exist: ${from}`);
  if (await fs.exists(to)) throw new Error(`Destination already exists: ${to}`);

  const fromType = projectTypeFromPath(from);
  const toType = projectTypeFromPath(to);
  const explicitType = options.projectType;
  const effectiveType = explicitType ?? toType ?? fromType;
  const warnings: string[] = [];
  const rewrites: Array<{ file: string; description: string }> = [];
  if (!fromType || !toType)
    warnings.push(
      "Could not infer project type from one or both paths; only generic rewrites will run."
    );
  if (fromType && toType && fromType !== toType && !explicitType) {
    throw new Error(
      `Fork crosses project types (${fromType} -> ${toType}); pass projectType to opt into this.`
    );
  }
  if (explicitType && toType && explicitType !== toType) {
    throw new Error(
      `Destination path ${to} is a ${toType}, not requested projectType ${explicitType}`
    );
  }

  const oldName = projectNameFromPath(from);
  const newName = projectNameFromPath(to);
  const newTitle = options.title ?? newName;
  const files = await listFilesRecursive(from);
  const createdFiles: string[] = [];
  const planned: Record<string, string | Uint8Array> = {};
  const effectiveClassMap: Record<string, string> = { ...(options.classMap ?? {}) };
  const binaryFiles: string[] = [];

  for (const rel of files) {
    const srcPath = `${from}/${rel}`;
    const destRel = rewriteRelPath(rel, oldName, newName, effectiveType);
    if (destRel !== rel) {
      rewrites.push({ file: rel, description: `Renamed forked file path to ${destRel}` });
    }
    createdFiles.push(destRel);
    if (!isProbablyTextFile(rel)) {
      binaryFiles.push(destRel);
      if (!options.dryRun) {
        planned[destRel] = (await fs.readFile(srcPath)) as Uint8Array;
      }
      continue;
    }
    let content = await readText(srcPath);

    if (rel === "package.json") {
      try {
        const pkg = JSON.parse(content);
        if (rewriteEnabled(options, "packageName")) {
          const scope = effectiveType ? PACKAGE_SCOPES[effectiveType] : undefined;
          if (scope) pkg.name = `${scope}/${newName}`;
          rewrites.push({ file: rel, description: "Updated package name" });
        }
        if (rewriteEnabled(options, "title")) {
          pkg.natstack = { ...(pkg.natstack ?? {}), title: newTitle };
          rewrites.push({ file: rel, description: "Updated natstack title" });
        }
        if (
          pkg.natstack?.entry &&
          typeof pkg.natstack.entry === "string" &&
          pkg.natstack.entry.includes(oldName)
        ) {
          pkg.natstack.entry = pkg.natstack.entry.split(oldName).join(newName);
          rewrites.push({ file: rel, description: "Updated natstack entry path" });
        }
        if (effectiveType === "worker" && rewriteEnabled(options, "workerClassNames")) {
          const classes = pkg.natstack?.durable?.classes;
          if (Array.isArray(classes)) {
            if (classes.length === 1) {
              const oldClass = classes[0]?.className;
              if (oldClass) {
                const nextClass = effectiveClassMap[oldClass] ?? `${toPascalCase(newName)}Worker`;
                effectiveClassMap[oldClass] = nextClass;
                classes[0].className = nextClass;
                rewrites.push({
                  file: rel,
                  description: `Updated durable class ${oldClass} -> ${nextClass}`,
                });
              } else {
                warnings.push(
                  "Worker durable class metadata is missing className; no class rewrite was applied."
                );
              }
            } else if (classes.length > 1) {
              const unmapped = classes.filter(
                (c: { className?: string }) => c.className && !effectiveClassMap[c.className]
              );
              if (unmapped.length > 0)
                warnings.push(
                  "Worker has multiple durable classes; provide classMap for complete safe renaming."
                );
              for (const c of classes)
                if (effectiveClassMap[c.className]) c.className = effectiveClassMap[c.className];
            }
          }
        }
        content = JSON.stringify(pkg, null, 2) + "\n";
      } catch (err) {
        warnings.push(
          `Could not parse package.json: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (effectiveType === "skill" && rel === "SKILL.md") {
      content = content.replace(/^name:\s*.+$/m, `name: ${newName}`);
      if (options.title)
        content = content.replace(/^description:\s*.+$/m, `description: ${newTitle}`);
      rewrites.push({ file: rel, description: "Updated skill frontmatter" });
    }

    if (effectiveType === "worker" && rewriteEnabled(options, "workerClassNames")) {
      for (const [oldClass, nextClass] of Object.entries(effectiveClassMap)) {
        if (content.includes(oldClass)) {
          content = content.split(oldClass).join(nextClass);
          rewrites.push({
            file: destRel,
            description: `Rewrote class reference ${oldClass} -> ${nextClass}`,
          });
        }
      }
      if (content.includes(oldName)) {
        content = content.split(oldName).join(newName);
        rewrites.push({
          file: destRel,
          description: `Rewrote worker source string ${oldName} -> ${newName}`,
        });
      }
    }

    planned[destRel] = content;
  }

  if (binaryFiles.length > 0) {
    warnings.push(`Binary files will be copied unchanged: ${binaryFiles.join(", ")}`);
  }

  try {
    if (await fs.exists("meta/natstack.yml")) {
      const meta = await readText("meta/natstack.yml");
      if (
        meta.includes(from) ||
        Object.keys(effectiveClassMap).some((oldClass) => meta.includes(oldClass))
      ) {
        warnings.push(
          "Workspace meta/natstack.yml references the source project or worker classes; review global config before launching the fork."
        );
      }
    }
  } catch {
    // Best-effort warning only.
  }

  if (options.dryRun) {
    return {
      source: from,
      created: to,
      files: createdFiles,
      rewrites,
      warnings,
      committed: false,
      dryRun: true,
    };
  }

  const initialFiles: Record<string, string | Uint8Array> = {};
  for (const [rel, content] of Object.entries(planned)) initialFiles[rel] = content;
  await writeProjectFiles(to, initialFiles);
  await vcs.commit(to, options.commitMessage ?? `Fork ${from} to ${to}`);
  return {
    source: from,
    created: to,
    files: createdFiles,
    rewrites,
    warnings,
    committed: true,
    dryRun: false,
  };
}

export async function forkPanel(params: {
  from: string;
  name: string;
  title?: string;
  dryRun?: boolean;
}): Promise<ForkProjectResult> {
  return forkProject({
    from: params.from,
    to: `panels/${params.name}`,
    title: params.title,
    dryRun: params.dryRun,
  });
}

export async function forkWorker(params: {
  from: string;
  name: string;
  title?: string;
  classMap?: Record<string, string>;
  dryRun?: boolean;
}): Promise<ForkProjectResult> {
  return forkProject({
    from: params.from,
    to: `workers/${params.name}`,
    title: params.title,
    classMap: params.classMap,
    dryRun: params.dryRun,
  });
}
