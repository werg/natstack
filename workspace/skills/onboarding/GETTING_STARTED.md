# Getting Started

A step-by-step guide for onboarding. The agent should first detect the user's experience level, then walk through the relevant steps interactively.

## Step 0: Detect Experience Level

Before anything else, check how many workspaces exist:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  const workspaces = await workspace.list();
  const active = await workspace.getActive();
  return { count: workspaces.length, names: workspaces.map(w => w.name), active };
` })
```

- **`count <= 1`** → new user. Start from Step 1, explain concepts thoroughly. Note: in IPC/remote mode `workspace.list()` may return `[]` even when an active workspace exists — treat `count === 0` with a valid `active` as a new user too.
- **`count > 1`** → returning user. Greet them briefly, mention their active workspace, and ask what they need. Skip to whichever step is relevant, or point them to the right skill directly.

## Step 1: Explore Your Workspace

Start by showing the user what's in their workspace:

```
eval({ code: `
  import { workspace, fs } from "@workspace/runtime";
  const config = await workspace.getConfig();
  console.log("Workspace:", config.id);
  console.log("Init panels:", config.initPanels);

  const entries = await fs.readdir("/", { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  console.log("Top-level directories:", dirs.join(", "));
  return { config, dirs };
` })
```

Key directories:
- `panels/` — panel apps (UI)
- `packages/` — shared workspace packages
- `workers/` — workerd workers and Durable Objects
- `agents/` — agent definitions
- `skills/` — skill documentation (like this one)

## Step 2: Import Browser Data

If the user wants to bring in their existing browser data (cookies for authentication, bookmarks, passwords), use the **browser-import** skill.

Quick start — detect what browsers are available:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();
  for (const b of browsers) {
    const status = b.tccBlocked ? " (blocked — needs permission)" : "";
    console.log(b.displayName + status + " — " + b.profiles.length + " profile(s)");
    for (const p of b.profiles) {
      console.log("  " + p.displayName + (p.isDefault ? " (default)" : ""));
    }
  }
  return browsers;
`, timeout: 30000 })
```

Then ask the user which browser/profile to import from and which data types they want. See the `browser-import` skill docs for:
- [DISCOVERY.md](../browser-import/DISCOVERY.md) — browser detection and profile enumeration
- [IMPORT.md](../browser-import/IMPORT.md) — running imports
- [COOKIES.md](../browser-import/COOKIES.md) — cookie management and session sync
- [PASSWORDS.md](../browser-import/PASSWORDS.md) — password vault
- [BOOKMARKS.md](../browser-import/BOOKMARKS.md) — bookmark browsing
- [WORKFLOWS.md](../browser-import/WORKFLOWS.md) — end-to-end recipes

## Step 3: Set Up API Integrations (OAuth)

NatStack can connect to third-party APIs (Gmail, Google Calendar, GitHub, Slack, Notion, Linear) via OAuth. This requires a free Nango account for token management.

**Check if already configured:**

```
eval({ code: `
  import { oauth } from "@workspace/runtime";
  const providers = await oauth.listProviders();
  if (providers.length > 0) {
    console.log("OAuth is configured. Available providers:", providers.map(p => p.key).join(", "));
    const connections = await oauth.listConnections();
    if (connections.length > 0) {
      console.log("Active connections:", connections.map(c => c.provider).join(", "));
    }
  } else {
    console.log("OAuth is not configured yet.");
  }
  return { configured: providers.length > 0, providers };
`, timeout: 10000 })
```

If not configured, show an inline UI offering to set it up. **Don't push this on the user** — some users only want local features. Explain what it enables and let them decide.

Before showing the UI, check whether the user has imported browser data (which affects whether the internal browser panel is useful):

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const history = await browserData.getImportHistory();
  const hasImported = history.length > 0;
  const nangoCookies = await browserData.getCookies("nango.dev");
  const hasNangoCookies = nangoCookies.length > 0;
  return { hasImported, hasNangoCookies };
`, timeout: 5000 })
```

Use the result to decide what to recommend in the inline UI. If they've imported browser data, the internal browser panel is a good option (cookies + autofill will be available). If not, the external browser is better since the user is likely already signed in there.

```
inline_ui({
  component: `
    const [step, setStep] = useState("intro");
    const [key, setKey] = useState("");

    // Set these based on the browserData check above
    const hasImported = props.hasImported ?? false;
    const hasNangoCookies = props.hasNangoCookies ?? false;

    if (step === "intro") return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div>API integrations let you connect Gmail, Calendar, GitHub, Slack, and more from NatStack.</div>
        <div>This requires a free <strong>Nango</strong> account (an OAuth proxy service).</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setStep("setup")}>Set up now</button>
          <button onClick={() => resolve({ skipped: true })}>Skip for now</button>
        </div>
      </div>
    );

    if (step === "setup") return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div><strong>1. Sign up or log in to Nango</strong> (free)</div>
        <div style={{ display: "flex", gap: 8 }}>
          {hasImported && (
            <button onClick={() => resolve({ action: "open-panel" })}>
              Open in NatStack browser{hasNangoCookies ? " (already logged in)" : ""}
            </button>
          )}
          <button onClick={() => resolve({ action: "open-external" })}>
            Open in system browser
          </button>
        </div>
        <div style={{ color: "#888", fontSize: "0.9em" }}>
          {hasImported
            ? "The NatStack browser has your imported cookies and autofill."
            : "Using your system browser since no browser data has been imported yet."}
        </div>
      </div>
    );
  `,
})
```

**Handle the result:**

- If `action === "open-panel"` — open the Nango dashboard in a browser panel:
  ```
  eval({ code: \`
    import { createBrowserPanel } from "@workspace/runtime";
    await createBrowserPanel("https://app.nango.dev", { name: "Nango Setup", focus: true });
  \`, timeout: 10000 })
  ```

- If `action === "open-external"` — open in the system browser:
  ```
  eval({ code: \`
    import { openExternal } from "@workspace/runtime";
    await openExternal("https://app.nango.dev");
  \`, timeout: 5000 })
  ```

After the user has the dashboard open (either way), show a follow-up inline UI for the remaining steps.

**IMPORTANT: Never read secret values into the model's context.** The inline UI below calls `rpc.call("main", "secrets.setSecret", ...)` directly from component code so the key goes straight from the user's input to the secrets service without passing through the model. The resolve value should only indicate success/skip — never contain the key itself.

```
inline_ui({
  component: `
    const [key, setKey] = useState("");
    const [status, setStatus] = useState("idle"); // idle | saving | saved | error
    const [error, setError] = useState("");

    const handleSave = async () => {
      setStatus("saving");
      try {
        await rpc.call("main", "secrets.setSecret", "nango", key);
        setStatus("saved");
        resolve({ saved: true });
      } catch (e) {
        setStatus("error");
        setError(e.message || "Failed to save");
      }
    };

    if (status === "saved") return (
      <div>Nango secret saved. Restart the workspace to activate OAuth.</div>
    );

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div><strong>2. Enable providers</strong> — In the Nango dashboard, enable the providers you want (Google, GitHub, Slack, etc.)</div>
        <div><strong>3. Copy your secret key</strong> — Go to Settings → Secret Key</div>
        <div><strong>4. Paste it here:</strong></div>
        <input
          type="password"
          placeholder="sk-..."
          value={key}
          onChange={e => setKey(e.target.value)}
          style={{ fontFamily: "monospace", padding: 6 }}
        />
        {status === "error" && <div style={{ color: "red" }}>{error}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={!key.startsWith("sk-") || status === "saving"}
            onClick={handleSave}
          >{status === "saving" ? "Saving..." : "Save key"}</button>
          <button onClick={() => resolve({ skipped: true })}>Skip</button>
        </div>
      </div>
    );
  `,
})
```

The result will be `{ saved: true }` or `{ skipped: true }` — the model never sees the key. After saving, tell the user they need to restart the workspace for the new secret to take effect. Then point them to the `api-integrations` skill for connecting individual providers.

## Step 4: Set Up a Workspace

If the user wants to organize their work into separate workspaces:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";

  // List existing workspaces
  const workspaces = await workspace.list();
  console.log("Workspaces:");
  for (const ws of workspaces) {
    const active = ws.name === await workspace.getActive() ? " (active)" : "";
    console.log("  " + ws.name + active);
  }
  return workspaces;
` })
```

Create a new workspace (optionally forking from an existing one):

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  const active = await workspace.getActive();
  const entry = await workspace.create("my-workspace", { forkFrom: active });
  console.log("Created workspace:", entry.name);
` })
```

Configure which panels open on first launch:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  await workspace.setInitPanels([{ source: "panels/chat" }]);
  console.log("Init panels set");
` })
```

Switch to a workspace (this relaunches the app):

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  await workspace.switchTo("my-workspace");
` })
```

## Step 5: Create Your First Panel

Use the **paneldev** skill to scaffold and launch a panel. See the `paneldev` skill for the full workflow:
- [WORKFLOW.md](../paneldev/WORKFLOW.md) — step-by-step development process
- [PANEL_DEVELOPMENT.md](../paneldev/PANEL_DEVELOPMENT.md) — hooks, filesystem, templates
- [PANEL_SYSTEM.md](../paneldev/PANEL_SYSTEM.md) — API reference

Quick version:

```
eval({ code: `
  import { createProject } from "@workspace-skills/paneldev";
  await createProject({ projectType: "panel", name: "hello", title: "Hello World" });
`, timeout: 30000 })
```

Then edit the generated files with Read/Edit/Write tools and launch:

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/hello", "Initial launch");
  await openPanel("panels/hello");
`, timeout: 30000 })
```

## Step 6: Explore the Runtime

Use the **sandbox** skill to learn what you can do from the chat panel:
- [EVAL.md](../sandbox/EVAL.md) — running code in the sandbox
- [INLINE_UI.md](../sandbox/INLINE_UI.md) — rendering interactive components in chat
- [RUNTIME_API.md](../sandbox/RUNTIME_API.md) — full API reference (fs, db, ai, workers, etc.)
- [BROWSER_AUTOMATION.md](../sandbox/BROWSER_AUTOMATION.md) — Playwright via CDP
- [PATTERNS.md](../sandbox/PATTERNS.md) — common recipes

## Adapting the Flow

Not every user needs every step. Tailor the walkthrough:

| User goal | Steps to focus on |
|-----------|-------------------|
| "I want to browse the web with my logins" | Steps 1, 2 (import cookies + sync) |
| "I want to connect Gmail/Slack/GitHub" | Steps 1, 2, 3 (import cookies + OAuth setup) |
| "I want to build an app" | Steps 1, 5 (scaffold + launch panel) |
| "I want to organize my projects" | Steps 1, 4 (workspace management) |
| "I want to see what this can do" | Steps 1, 6 (explore runtime APIs) |
| "Set everything up" | All steps in order |

Ask the user what they're most interested in and skip to the relevant section.
