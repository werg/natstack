/**
 * Project Scaffolding Service — creates new workspace projects.
 *
 * Files are written to the context folder, then committed and pushed to the
 * workspace git server (same flow as all other agent edits). PushTrigger
 * fires on push → build system auto-detects new project.
 */

import * as path from "path";
import * as fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { validateProjectName, resolveWithinContext } from "../contextPaths.js";
import { createDevLogger } from "@natstack/dev-log";
import type { ContextFolderManager } from "../contextFolderManager.js";
import type { GitServer } from "../gitServer.js";
import type { TokenManager } from "../tokenManager.js";

const execFileAsync = promisify(execFile);
const log = createDevLogger("ProjectService");

/** Type directories by project type */
const TYPE_DIRS: Record<string, string> = {
  panel: "panels",
  package: "packages",
  skill: "skills",
  agent: "agents",
};

/** Package scope by project type */
const PACKAGE_SCOPES: Record<string, string> = {
  panel: "@workspace-panels",
  package: "@workspace",
  skill: "@workspace-skills",
  agent: "@workspace-agents",
};

interface ProjectTemplate {
  files: Record<string, string>;
}

function generateTemplate(type: string, name: string, title: string): ProjectTemplate {
  switch (type) {
    case "panel":
      return {
        files: {
          "package.json": JSON.stringify(
            {
              name: `${PACKAGE_SCOPES[type]}/${name}`,
              version: "0.1.0",
              private: true,
              type: "module",
              natstack: { title },
              dependencies: {
                "@workspace/runtime": "workspace:*",
                "@workspace/react": "workspace:*",
                "@radix-ui/themes": "^3.2.1",
              },
            },
            null,
            2,
          ),
          "index.tsx": `import { usePanelTheme } from "@workspace/react";
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
`,
        },
      };

    case "package":
      return {
        files: {
          "package.json": JSON.stringify(
            {
              name: `${PACKAGE_SCOPES[type]}/${name}`,
              version: "0.1.0",
              private: true,
              type: "module",
              exports: { ".": "./index.ts" },
            },
            null,
            2,
          ),
          "index.ts": `/**\n * ${title}\n */\n\nexport {};\n`,
        },
      };

    case "skill":
      return {
        files: {
          "package.json": JSON.stringify(
            {
              name: `${PACKAGE_SCOPES[type]}/${name}`,
              version: "0.1.0",
            },
            null,
            2,
          ),
          "SKILL.md": `---\nname: ${name}\ndescription: ${title}\n---\n\n# ${title}\n`,
        },
      };

    case "agent":
      return {
        files: {
          "package.json": JSON.stringify(
            {
              name: `${PACKAGE_SCOPES[type]}/${name}`,
              version: "0.1.0",
              natstack: { type: "worker", title },
            },
            null,
            2,
          ),
          "index.ts": `/**\n * ${title} agent\n */\n\nconsole.log("${title} agent started");\n`,
        },
      };

    default:
      throw new Error(`Unknown project type: ${type}`);
  }
}

function toPascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

async function gitExec(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout || stderr || "";
}

export async function handleProjectCall(
  contextFolderManager: ContextFolderManager,
  gitServer: GitServer,
  tokenManager: TokenManager,
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (method !== "create") {
    throw new Error(`Unknown project method: ${method}`);
  }

  const contextId = args[0] as string;
  const type = args[1] as string;
  const name = args[2] as string;
  const title = (args[3] as string | undefined) ?? name;

  log.info(`Creating ${type} project: ${name} (title: ${title}, context: ${contextId})`);

  // Validate inputs
  validateProjectName(name);
  const typeDir = TYPE_DIRS[type];
  if (!typeDir) {
    throw new Error(`Unknown project type: ${type}. Must be one of: panel, package, skill, agent`);
  }

  const contextRoot = await contextFolderManager.ensureContextFolder(contextId);
  const projectDir = resolveWithinContext(contextRoot, path.join(typeDir, name));

  // Check if project already exists
  if (fs.existsSync(projectDir)) {
    throw new Error(`Project already exists: ${typeDir}/${name}`);
  }

  // Generate template
  const template = generateTemplate(type, name, title);

  // Create directory and write files
  fs.mkdirSync(projectDir, { recursive: true });

  for (const [filePath, content] of Object.entries(template.files)) {
    const fullPath = path.join(projectDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
  log.info(`Template files written to ${projectDir}`);

  // Initialize git repo
  await gitExec(projectDir, ["init", "-b", "main"]);
  await gitExec(projectDir, ["config", "user.email", "natstack@local"]);
  await gitExec(projectDir, ["config", "user.name", "NatStack"]);

  // Configure remote
  const repoPath = `${typeDir}/${name}`;
  const remoteUrl = `${gitServer.getBaseUrl()}/${repoPath}`;
  await gitExec(projectDir, ["remote", "add", "origin", remoteUrl]);
  log.info(`Git initialized with remote: ${remoteUrl}`);

  // Commit
  await gitExec(projectDir, ["add", "-A"]);
  await gitExec(projectDir, ["commit", "-m", `Create ${type}: ${title}`]);

  // Configure auth and push
  const token = tokenManager.ensureToken(contextId, "server");
  await gitExec(projectDir, [
    "config", "http.extraHeader", `Authorization: Bearer ${token}`,
  ]);

  try {
    await gitExec(projectDir, ["push", "-u", "origin", "main"]);
    log.info(`Pushed ${typeDir}/${name} to origin`);
  } catch (pushErr: unknown) {
    const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    log.warn(`Push failed for ${typeDir}/${name}: ${msg}`);
    // Still return success — files are committed locally in the context folder.
    // The agent can push manually later via the git tool.
    return {
      created: `${typeDir}/${name}`,
      type,
      name,
      title,
      files: Object.keys(template.files),
      pushFailed: true,
      pushError: msg,
    };
  }

  return {
    created: `${typeDir}/${name}`,
    type,
    name,
    title,
    files: Object.keys(template.files),
  };
}
