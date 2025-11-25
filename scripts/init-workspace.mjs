#!/usr/bin/env node
/**
 * Initialize a new NatStack workspace
 *
 * Usage: node scripts/init-workspace.mjs [workspace-path]
 *
 * Creates:
 * - natstack.yml with default configuration
 * - panels/ directory structure
 * - git-repos/ directory
 * - .cache/ directory
 *
 * Note: API keys and model roles are configured in the central config directory
 * (~/.config/natstack/ on Linux, ~/Library/Application Support/natstack/ on macOS)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Default workspace path
const workspacePath = process.argv[2] || "./my-workspace";
const resolvedPath = path.resolve(workspacePath);

console.log(`\n🚀 Initializing NatStack workspace at: ${resolvedPath}\n`);

// Check if already exists
if (fs.existsSync(path.join(resolvedPath, "natstack.yml"))) {
  console.log("⚠️  Workspace already exists at this location.");
  console.log("   Delete natstack.yml to reinitialize.\n");
  process.exit(1);
}

// Generate workspace ID
const workspaceId = `workspace-${crypto.randomBytes(4).toString("hex")}`;

// Create directory structure (no state/ prefix)
const dirs = [
  "",
  "panels",
  "git-repos",
  ".cache",
];

for (const dir of dirs) {
  const fullPath = path.join(resolvedPath, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`📁 Created: ${dir || "."}/`);
  }
}

// Create natstack.yml (workspace-specific config only)
const natstackYml = `# NatStack Workspace Configuration
# Generated: ${new Date().toISOString()}

id: ${workspaceId}

# Git server configuration
git:
  port: 63524

# Root panel to load on startup (relative to workspace)
root-panel: panels/root
`;

fs.writeFileSync(path.join(resolvedPath, "natstack.yml"), natstackYml);
console.log("📄 Created: natstack.yml");

// Create .gitkeep files
const gitkeeps = [
  "panels/.gitkeep",
  "git-repos/.gitkeep",
  ".cache/.gitkeep",
];

for (const file of gitkeeps) {
  const fullPath = path.join(resolvedPath, file);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, "");
  }
}

// Create a minimal example panel if panels is empty
const panelsPath = path.join(resolvedPath, "panels");
const panelFiles = fs.readdirSync(panelsPath).filter(f => f !== ".gitkeep");

if (panelFiles.length === 0) {
  const rootPanelPath = path.join(panelsPath, "root");
  fs.mkdirSync(rootPanelPath, { recursive: true });

  // Create package.json
  const packageJson = {
    name: "@natstack-panels/root",
    type: "module",
    natstack: {
      title: "Root Panel",
      entry: "index.tsx",
    },
  };

  fs.writeFileSync(
    path.join(rootPanelPath, "package.json"),
    JSON.stringify(packageJson, null, 2)
  );

  // Create minimal index.tsx
  const indexTsx = `import { Button, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { usePanelTheme, usePanelId } from "@natstack/panel";

export default function RootPanel() {
  const theme = usePanelTheme();
  const panelId = usePanelId();

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3">
        <Flex direction="column" gap="4">
          <Heading size="6">Hello NatStack!</Heading>
          <Text>Theme: {theme.appearance}</Text>
          <Text>Panel ID: {panelId}</Text>
          <Button>Click me</Button>
        </Flex>
      </Card>
    </div>
  );
}
`;

  fs.writeFileSync(path.join(rootPanelPath, "index.tsx"), indexTsx);
  console.log("📁 Created: panels/root/");
}

// Get central config path hint
const centralConfigPath = process.platform === "darwin"
  ? "~/Library/Application Support/natstack/"
  : "~/.config/natstack/";

console.log(`
✅ Workspace initialized!

Next steps:
1. Configure API keys in ${centralConfigPath}.secrets.yml:
   anthropic: sk-ant-...
   openai: sk-...

2. Optionally configure model roles in ${centralConfigPath}config.yml:
   models:
     smart: anthropic:claude-sonnet-4-20250514
     fast: groq:llama-3.1-8b-instant

3. Run NatStack with this workspace:
   node scripts/run-electron.mjs --workspace=${workspacePath}

4. Or set the NATSTACK_WORKSPACE environment variable:
   NATSTACK_WORKSPACE=${resolvedPath} pnpm dev

Workspace ID: ${workspaceId}
`);
