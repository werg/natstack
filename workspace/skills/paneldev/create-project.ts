import { fs, gitConfig } from "@workspace/runtime";
import { GitClient, initAndPush } from "@natstack/git";

// ---------------------------------------------------------------------------
// Shared git client helper
// ---------------------------------------------------------------------------

function createGit(): GitClient {
  if (!gitConfig) throw new Error("Git config not available");
  return new GitClient(fs, {
    serverUrl: gitConfig.serverUrl,
    token: gitConfig.token,
  });
}

// ---------------------------------------------------------------------------
// commitAndPush — stage, commit, and push changes to the git server
// ---------------------------------------------------------------------------

/**
 * Stage all changes in a repo directory, commit, and push to the git server.
 * Context folders include .git with shared object store, so this works on
 * any pre-existing repo. Adds the "origin" remote if not configured yet.
 */
export async function commitAndPush(
  dir: string,
  message: string,
): Promise<string> {
  const git = createGit();

  // Ensure remote is configured (context folders copy .git but workspace
  // repos don't have remotes — the remote path matches the repo path)
  const remotes = await git.listRemotes(dir);
  if (!remotes.some((r) => r.remote === "origin")) {
    await git.addRemote(dir, "origin", dir);
  }

  await git.addAll(dir);

  const status = await git.status(dir);
  const hasChanges = status.files.some(
    (f) => f.status !== "unmodified" && f.status !== "ignored",
  );
  if (!hasChanges) return "Nothing to commit";

  const sha = await git.commit({ dir, message });
  await git.push({ dir, ref: "main" });
  return `Committed ${sha.slice(0, 7)} and pushed to origin/main`;
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
  return str.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

export async function createProject(
  params: { projectType: string; name: string; title?: string; template?: string },
): Promise<{ created: string; files: string[] }> {
  const { projectType, name, title = name, template } = params;

  const typeDir = TYPE_DIRS[projectType];
  if (!typeDir) throw new Error(`Unknown project type: ${projectType}. Must be one of: panel, package, skill, agent, worker`);

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
        if (!await fs.exists(templateConfigPath)) {
          throw new Error(`Template "${panelTemplate}" not found. Check workspace/templates/ for available templates.`);
        }
        const templateConfig = JSON.parse(
          await fs.readFile(templateConfigPath, "utf-8") as string,
        );
        if (templateConfig.framework) panelFramework = templateConfig.framework;
      } else {
        try {
          const templateConfig = JSON.parse(
            await fs.readFile(`templates/default/template.json`, "utf-8") as string,
          );
          if (templateConfig.framework) panelFramework = templateConfig.framework;
        } catch {
          // Default template missing — use React defaults
        }
      }

      if (panelFramework === "svelte") {
        files["package.json"] = JSON.stringify({
          name: `${scope}/${name}`,
          version: "0.1.0",
          private: true,
          type: "module",
          natstack: { title, ...(panelTemplate !== "default" ? { template: panelTemplate } : {}) },
          dependencies: {
            "@workspace/runtime": "workspace:*",
            "@workspace/svelte": "workspace:*",
            "svelte": "^5.0.0",
          },
        }, null, 2);
        files["index.ts"] = `export { default } from "./App.svelte";\n`;
        files["App.svelte"] = `<script>
  import { theme } from "@workspace/svelte";
</script>

<div class="container" class:dark={$theme === "dark"}>
  <h1>${title}</h1>
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
        files["package.json"] = JSON.stringify({
          name: `${scope}/${name}`,
          version: "0.1.0",
          private: true,
          type: "module",
          natstack: { title, ...(panelTemplate !== "default" ? { template: panelTemplate } : {}) },
          dependencies: {
            "@workspace/runtime": "workspace:*",
            "@workspace/react": "workspace:*",
            "@radix-ui/themes": "^3.2.1",
          },
        }, null, 2);
        files["index.tsx"] = `import { usePanelTheme } from "@workspace/react";
import { Flex, Text, Theme } from "@radix-ui/themes";

export default function ${toPascalCase(name)}() {
  const theme = usePanelTheme();

  return (
    <Theme appearance={theme}>
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh" }}>
        <Text size="5">${title}</Text>
      </Flex>
    </Theme>
  );
}
`;
      }
      break;
    }

    case "package":
      files["package.json"] = JSON.stringify({
        name: `${scope}/${name}`,
        version: "0.1.0",
        private: true,
        type: "module",
        exports: { ".": "./index.ts" },
      }, null, 2);
      files["index.ts"] = `/**\n * ${title}\n */\n\nexport {};\n`;
      break;

    case "skill":
      files["package.json"] = JSON.stringify({
        name: `${scope}/${name}`,
        version: "0.1.0",
        private: true,
        type: "module",
        exports: { ".": "./index.ts" },
        dependencies: { "@workspace/runtime": "workspace:*" },
      }, null, 2);
      files["index.ts"] = `/**\n * ${title}\n */\n\nexport {};\n`;
      files["SKILL.md"] = `---\nname: ${name}\ndescription: ${title}\n---\n\n# ${title}\n`;
      break;

    case "agent":
      files["package.json"] = JSON.stringify({
        name: `${scope}/${name}`,
        version: "0.1.0",
        natstack: { type: "agent", title },
      }, null, 2);
      files["index.ts"] = `/**\n * ${title} agent\n */\n\nconsole.log("${title} agent started");\n`;
      break;

    case "worker":
      if (template === "agentic") {
        // Agentic worker template — DO extending AgentWorkerBase
        const className = toPascalCase(name) + "Worker";
        const workerFileName = `${name}-worker`;

        files["package.json"] = JSON.stringify({
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
            "@natstack/harness": "workspace:*",
          },
        }, null, 2);

        files["index.ts"] = `export { ${className} } from "./${workerFileName}.js";
export default { fetch(_req: Request) { return new Response("${name} DO service"); } };
`;

        files[`${workerFileName}.ts`] = `import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness";

/**
 * ${className} — Pi-native agent DO.
 *
 * Pi (\`@mariozechner/pi-agent-core\`) runs in-process. The base class
 * handles channel subscriptions, the channel event pipeline, the per-channel
 * PiRunner lifecycle, and forwards Pi state to the channel as snapshot/text-delta
 * ephemerals. You only need to override the small set of customization hooks
 * below.
 *
 * The system prompt lives in <contextFolder>/.pi/AGENTS.md. Workspace skills
 * live in <contextFolder>/.pi/skills/. Both are loaded automatically.
 */
export class ${className} extends AgentWorkerBase {
  static override schemaVersion = 1;

  // --- Hook: model id (provider:model format) ---
  // protected override getModel(): string {
  //   return "anthropic:claude-sonnet-4-20250514";
  // }

  // --- Hook: thinking level ---
  // protected override getThinkingLevel() {
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
import type { ChannelEvent } from "@natstack/harness";
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
        files["package.json"] = JSON.stringify({
          name: `${scope}/${name}`,
          version: "0.1.0",
          private: true,
          type: "module",
          natstack: { type: "worker", entry: "index.ts", title },
          dependencies: { "@workspace/runtime": "workspace:*" },
        }, null, 2);
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

  // Use isomorphic-git to init repo, write files, commit, and push
  // This goes directly to the git server over HTTP — no server-side RPC needed
  const git = createGit();

  await initAndPush(git, fs, {
    dir: projectPath,
    remote: projectPath,
    initialFiles: files,
    message: `Create ${projectType}: ${title}`,
  });

  return { created: projectPath, files: Object.keys(files) };
}
