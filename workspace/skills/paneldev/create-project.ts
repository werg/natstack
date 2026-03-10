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
  params: { projectType: string; name: string; title?: string },
): Promise<{ created: string; files: string[] }> {
  const { projectType, name, title = name } = params;

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
    case "panel":
      files["package.json"] = JSON.stringify({
        name: `${scope}/${name}`,
        version: "0.1.0",
        private: true,
        type: "module",
        natstack: { title },
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
      break;

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
