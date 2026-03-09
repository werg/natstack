// Create a new workspace project.
// Usage: prepend variable definitions, then eval this script:
//
//   eval({ code: `
//     const PROJECT_TYPE = "panel";
//     const PROJECT_NAME = "my-app";
//     const PROJECT_TITLE = "My App";
//     ${scriptContents}
//   `, timeout: 30000 })

import { fs, rpc } from "@workspace/runtime";

declare const PROJECT_TYPE: string;
declare const PROJECT_NAME: string;
declare const PROJECT_TITLE: string;
declare const contextId: string;

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

const typeDir = TYPE_DIRS[PROJECT_TYPE];
if (!typeDir) throw new Error(`Unknown project type: ${PROJECT_TYPE}. Must be one of: panel, package, skill, agent, worker`);

const scope = PACKAGE_SCOPES[PROJECT_TYPE];
const projectPath = `${typeDir}/${PROJECT_NAME}`;

// Check if already exists
if (await fs.exists(projectPath)) {
  throw new Error(`Project already exists: ${projectPath}`);
}

// Create directory
await fs.mkdir(projectPath, { recursive: true });

// Generate and write template files
const files: Record<string, string> = {};

switch (PROJECT_TYPE) {
  case "panel":
    files["package.json"] = JSON.stringify({
      name: `${scope}/${PROJECT_NAME}`,
      version: "0.1.0",
      private: true,
      type: "module",
      natstack: { title: PROJECT_TITLE },
      dependencies: {
        "@workspace/runtime": "workspace:*",
        "@workspace/react": "workspace:*",
        "@radix-ui/themes": "^3.2.1",
      },
    }, null, 2);
    files["index.tsx"] = `import { usePanelTheme } from "@workspace/react";
import { Flex, Text, Theme } from "@radix-ui/themes";

export default function ${toPascalCase(PROJECT_NAME)}() {
  const theme = usePanelTheme();

  return (
    <Theme appearance={theme}>
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh" }}>
        <Text size="5">${PROJECT_TITLE}</Text>
      </Flex>
    </Theme>
  );
}
`;
    break;

  case "package":
    files["package.json"] = JSON.stringify({
      name: `${scope}/${PROJECT_NAME}`,
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./index.ts" },
    }, null, 2);
    files["index.ts"] = `/**\n * ${PROJECT_TITLE}\n */\n\nexport {};\n`;
    break;

  case "skill":
    files["package.json"] = JSON.stringify({
      name: `${scope}/${PROJECT_NAME}`,
      version: "0.1.0",
    }, null, 2);
    files["SKILL.md"] = `---\nname: ${PROJECT_NAME}\ndescription: ${PROJECT_TITLE}\n---\n\n# ${PROJECT_TITLE}\n`;
    break;

  case "agent":
    files["package.json"] = JSON.stringify({
      name: `${scope}/${PROJECT_NAME}`,
      version: "0.1.0",
      natstack: { type: "agent", title: PROJECT_TITLE },
    }, null, 2);
    files["index.ts"] = `/**\n * ${PROJECT_TITLE} agent\n */\n\nconsole.log("${PROJECT_TITLE} agent started");\n`;
    break;

  case "worker":
    files["package.json"] = JSON.stringify({
      name: `${scope}/${PROJECT_NAME}`,
      version: "0.1.0",
      private: true,
      type: "module",
      natstack: { type: "worker", entry: "index.ts", title: PROJECT_TITLE },
      dependencies: { "@workspace/runtime": "workspace:*" },
    }, null, 2);
    files["index.ts"] = `import { createWorkerRuntime } from "@workspace/runtime/worker";
import type { WorkerEnv, ExecutionContext } from "@workspace/runtime/worker";

export default {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext) {
    const runtime = createWorkerRuntime(env);
    return new Response("Hello from ${PROJECT_TITLE}!");
  },
};
`;
    break;
}

for (const [fileName, content] of Object.entries(files)) {
  await fs.writeFile(`${projectPath}/${fileName}`, content);
}

// Commit and push (git is auto-initialized on first contextOp)
await rpc.call("main", "git.contextOp", contextId, "commit_and_push", projectPath, `Create ${PROJECT_TYPE}: ${PROJECT_TITLE}`);

console.log(`Created ${projectPath} with files: ${Object.keys(files).join(", ")}`);
