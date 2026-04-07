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
import type {
  ChannelEvent,
  HarnessConfig,
  HarnessOutput,
  ParticipantDescriptor,
} from "@natstack/harness";

export class ${className} extends AgentWorkerBase {
  static override schemaVersion = 1;

  // --- Hook: Harness configuration ---
  // Override to set system prompt, model, temperature, MCP servers, etc.
  protected override getHarnessConfig(): HarnessConfig {
    return {
      systemPrompt: "You are a helpful AI assistant.",
    };
  }

  // --- Hook: Participant identity ---
  // Override to set the handle, name, type, and callable methods.
  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: "${name}",
      name: "${title}",
      type: "agent",
      methods: [],
    };
  }

  // --- Hook: Event filter ---
  // Override to control which channel events trigger an AI turn.
  // Default: messages from client participants (panels + headless clients),
  // classified via isClientParticipantType from @natstack/pubsub.
  // protected override shouldProcess(event: ChannelEvent): boolean {
  //   if (event.type !== 'message') return false;
  //   const senderType = event.senderMetadata?.["type"] as string | undefined;
  //   return isClientParticipantType(senderType);
  // }

  // --- Hook: Turn input builder ---
  // Override to transform a channel event into AI turn input.
  // protected override buildTurnInput(event: ChannelEvent): TurnInput {
  //   const payload = event.payload as { content?: string };
  //   return { content: payload.content ?? '', senderId: event.senderId };
  // }

  // --- Hook: Harness type ---
  // Override to use a different AI provider.
  // protected override getHarnessType(): string { return 'claude-sdk'; }

  // --- Channel event handler ---
  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
  ): Promise<void> {
    if (!this.shouldProcess(event)) {
      this.advanceCheckpoint(channelId, null, event.id);
      return;
    }

    const input = this.buildTurnInput(event);
    const activeHarnessId = this.getActiveHarness();

    if (!activeHarnessId) {
      // No active harness — spawn one with the first turn
      const contextId = this.getContextId(channelId);
      const harnessId = \`harness-\${crypto.randomUUID()}\`;
      this.registerHarness(harnessId, this.getHarnessType());
      this.recordTurnStart(harnessId, channelId, input, event.messageId, event.id);
      await this.server.spawnHarness({
        doRef: this.doRef,
        harnessId,
        type: this.getHarnessType(),
        contextId,
        config: this.getHarnessConfig() as unknown as Record<string, unknown>,
        initialInput: input,
      });
    } else {
      // Existing harness — start a new turn
      this.setActiveTurn(activeHarnessId, channelId, event.messageId);
      this.setInFlightTurn(channelId, activeHarnessId, event.messageId, event.id, input);
      this.advanceCheckpoint(channelId, activeHarnessId, event.id);
      await this.server.sendHarnessCommand(activeHarnessId, { type: "start-turn", input });
    }
  }

  // --- Harness event handler ---
  async onHarnessEvent(
    harnessId: string,
    event: HarnessOutput,
  ): Promise<void> {
    if (event.type === "ready") {
      this.sql.exec(\`UPDATE harnesses SET status = 'active' WHERE id = ?\`, harnessId);
      return;
    }
    const turn = this.getActiveTurn(harnessId);
    const channelId = turn?.channelId;
    if (!channelId || !turn) return;

    const writer = this.createWriter(channelId, turn);

    switch (event.type) {
      case "text-start": await writer.startText(); break;
      case "text-delta": await writer.updateText(event.content); break;
      case "text-end": await writer.completeText(); break;
      case "turn-complete": {
        this.persistStreamState(harnessId, writer);
        const at = this.getActiveTurn(harnessId);
        if (at?.turnMessageId) {
          const inf = this.getInFlightTurn(channelId, harnessId);
          this.recordTurn(harnessId, at.turnMessageId, inf?.triggerPubsubId ?? 0, event.sessionId);
        }
        this.clearActiveTurn(harnessId);
        this.clearInFlightTurn(channelId, harnessId);
        break;
      }
    }

    this.persistStreamState(harnessId, writer);
  }
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
    senderType: "panel",
    ts: Date.now(),
    persist: true,
    ...overrides,
  };
}

describe("${className}", () => {
  it("processes user messages", async () => {
    const { instance } = await createTestDO(${className});
    // onChannelEvent returns void — side effects happen via direct HTTP calls
    await instance.onChannelEvent("ch-1", makeEvent({ id: 10 }));
  });

  it("filters non-panel events", async () => {
    const { instance } = await createTestDO(${className});
    // Non-panel events are filtered by shouldProcess() — no side effects
    await instance.onChannelEvent("ch-1", makeEvent({ senderType: "agent" }));
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
