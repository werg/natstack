# Eval Tool

Run TypeScript/JavaScript code in the panel sandbox. Code executes immediately, console output streams to the agent in real-time, and the return value is sent back.

## Basic Usage

```
eval({ code: `console.log("hello")` })
```

## Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | required | TypeScript/JavaScript code to execute |
| `syntax` | `"typescript" \| "jsx" \| "tsx"` | `"tsx"` | Source syntax |
| `timeout` | number (ms) | 10000 | Async timeout (0 = skip async, max 90000) |
| `imports` | `Record<string, string>` | — | Packages to build on-demand (workspace or npm) |

## Top-level Await

Fully supported. Async operations are automatically tracked and awaited:

```
eval({ code: `
  const response = await fetch("https://api.example.com/data");
  const data = await response.json();
  console.log(data);
  return data;
`, timeout: 30000 })
```

## Console Streaming

`console.log/warn/error/info/debug` output streams to the agent in real-time as the code runs. The final console output is also included in the return value.

## Dynamic Imports

Use the `imports` parameter to build and load packages on-demand — both workspace packages and third-party npm packages.

### Workspace packages

```
eval({
  code: `
    import { createProject } from "@workspace-skills/paneldev";
    await createProject({ projectType: "panel", name: "my-app", title: "My App" });
  `,
  imports: { "@workspace-skills/paneldev": "latest" },
  timeout: 30000
})
```

Values are git refs: `"latest"` (current HEAD), a branch name, tag, or commit SHA.

### npm packages

Use the `"npm:<version>"` value format to install and bundle third-party npm packages:

```
eval({
  code: `
    import _ from "lodash";
    console.log(_.chunk([1, 2, 3, 4, 5, 6], 2));
  `,
  imports: { "lodash": "npm:^4.17.21" },
  timeout: 30000
})
```

```
eval({
  code: `
    import * as d3 from "d3-array";
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    console.log("mean:", d3.mean(data));
    console.log("deviation:", d3.deviation(data));
  `,
  imports: { "d3-array": "npm:3" },
  timeout: 30000
})
```

Version values follow npm semver conventions: `"npm:^1.0.0"`, `"npm:~2.3.0"`, `"npm:3"`, `"npm:latest"`.

Packages are installed with `--ignore-scripts` for security (no postinstall hooks). Specifiers are validated against npm naming rules — only standard package names are accepted (no URLs, file paths, or git refs). Native addon packages (those requiring `.node` binary files) are not supported.

Installed packages and their bundles are both cached, so subsequent imports of the same package/version are fast. The first install of a new package may take 10–30 seconds (npm download + esbuild bundle), so use `timeout: 30000` or higher for initial imports.

### Mixing workspace and npm imports

```
eval({
  code: `
    import { createProject } from "@workspace-skills/paneldev";
    import Ajv from "ajv";
    const ajv = new Ajv();
    console.log("Ajv loaded:", typeof ajv.compile);
  `,
  imports: {
    "@workspace-skills/paneldev": "latest",
    "ajv": "npm:^8.12.0"
  },
  timeout: 30000
})
```

### Limitations

- npm packages are only available in `eval`, not in `inline_ui` or `feedback_custom` components. To use an npm package in a component, preload it via `eval` first (it will remain in the module map).
- Only packages with standard npm names are accepted (e.g. `lodash`, `@scope/pkg`). URLs, file paths, and git specifiers are rejected.
- Packages requiring native addons (`.node` binaries) won't work — esbuild cannot bundle them.

## Pre-injected Variables

Available without importing:

- **`contextId`** (string) — the panel's context ID
- **`chat`** (ChatSandboxValue) — publish messages, call methods, access RPC

## Filesystem Access

```
eval({ code: `
  import { fs } from "@workspace/runtime";
  const content = await fs.readFile("/src/index.ts", "utf-8");
  console.log(content);
` })
```

## Database Access

```
eval({ code: `
  import { db } from "@workspace/runtime";
  const conn = await db.open("my-data");
  await conn.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
  await conn.run("INSERT INTO items (name) VALUES (?)", ["test"]);
  const rows = await conn.query("SELECT * FROM items");
  console.log(rows);
  await conn.close();
` })
```

## Worker Management

```
eval({ code: `
  import { workers } from "@workspace/runtime";
  const sources = await workers.listSources();
  console.log("Available worker sources:", sources);
  const instances = await workers.list();
  console.log("Running instances:", instances);
` })
```

## AI Client

```
eval({ code: `
  import { ai } from "@workspace/runtime";
  const roles = await ai.listRoles();
  console.log("Available models:", Object.keys(roles));
  const result = await ai.generateText({
    model: "fast",
    messages: [{ role: "user", content: "Say hello in 3 words" }],
  });
  console.log(result);
`, timeout: 30000 })
```

## Git Operations

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const tree = await rpc.call("main", "git.getWorkspaceTree");
  console.log("Workspace tree:", tree);
  const branches = await rpc.call("main", "git.listBranches", ".");
  console.log("Branches:", branches);
` })
```

## Browser Data Import

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const browserData = createBrowserDataApi(rpc);

  // Detect installed browsers
  const browsers = await browserData.detectBrowsers();
  console.log("Detected browsers:", browsers.map(b => b.displayName));

  // Import cookies from Chrome
  const chrome = browsers.find(b => b.name === "chrome");
  if (chrome) {
    const result = await browserData.startImport({
      browser: "chrome",
      profilePath: chrome.profiles[0]?.path ?? chrome.dataDir,
      dataTypes: ["cookies"],
    });
    console.log("Import result:", result);
  }
`, timeout: 60000 })
```

## Panel Navigation

```
eval({ code: `
  import { openPanel, createBrowserPanel } from "@workspace/runtime";

  // Open a URL in a browser panel
  await openPanel("https://example.com");

  // Open a workspace panel
  await openPanel("panels/chat", { stateArgs: { topic: "hello" } });

  // Use createBrowserPanel when you need CDP automation
  const handle = await createBrowserPanel("https://example.com");
  const endpoint = await handle.getCdpEndpoint();
` })
```

## Sending Messages to Chat

```
eval({ code: `
  // chat is pre-injected
  await chat.publish("message", { content: "Hello from eval!" });
` })
```

## Build System

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  // Build a panel and get its bundle
  const build = await rpc.call("main", "build.getBuild", "panels/my-app");
  console.log("Build artifacts:", Object.keys(build));
  // Check effective version
  const ev = await rpc.call("main", "build.getEffectiveVersion", "panels/my-app");
  console.log("Effective version:", ev);
`, timeout: 30000 })
```

## Type Checking

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "typecheck.check", "panels/my-app");
  console.log("Type errors:", result);
`, timeout: 30000 })
```

## Return Values

The last expression or `return` value is serialized and sent back to the agent:

```
eval({ code: `
  import { fs } from "@workspace/runtime";
  const files = await fs.readdir("/src");
  return files;
` })
// Agent receives: { consoleOutput: "", returnValue: ["index.ts", "utils.ts", ...] }
```

Non-serializable values (functions, symbols, circular refs) are safely converted to string representations.
