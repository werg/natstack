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
| `imports` | `Record<string, string>` | — | Workspace packages to build on-demand |

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

Use the `imports` parameter to build and load workspace packages on-demand:

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
  import { focusPanel, buildPanelLink, createBrowserPanel } from "@workspace/runtime";

  // Open a URL in a browser panel
  const handle = await createBrowserPanel("https://example.com");

  // Build a link to another panel
  const link = buildPanelLink("panels/chat");
  console.log("Chat panel URL:", link);
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
