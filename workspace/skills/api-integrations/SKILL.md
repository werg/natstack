---
name: api-integrations
description: Connect to third-party APIs (Gmail, Notion, Slack, GitHub, Linear) via OAuth — setup, token management, npm SDK patterns, and building reusable integrations.
---

# API Integrations

How to connect to and use third-party APIs (Gmail, Notion, Slack, GitHub, etc.) from agent eval code.

## Prerequisites: OAuth Setup

OAuth requires a Nango account (free). Check if it's configured:

```
eval({
  code: `
    import { oauth } from "@workspace/runtime";
    const providers = await oauth.listProviders();
    if (providers.length === 0) {
      console.log("No OAuth providers configured.");
      console.log("To set up OAuth:");
      console.log("1. Sign up at https://app.nango.dev (free)");
      console.log("2. In the Nango dashboard, enable the providers you need (Google, GitHub, etc.)");
      console.log("3. Copy your secret key from Settings → Secret Key");
      console.log("4. Add it to ~/.config/natstack/.secrets.yml:");
      console.log("   nango: sk-your-secret-key-here");
      console.log("5. Restart the workspace");
    } else {
      console.log("Available providers:", providers.map(p => p.key).join(", "));
    }
    const connections = await oauth.listConnections();
    if (connections.length > 0) {
      console.log("Active connections:", connections.map(c => c.provider + (c.email ? " (" + c.email + ")" : "")).join(", "));
    }
  `,
  timeout: 10000
})
```

### Agent-guided setup

If OAuth isn't configured, guide the user through setup. The agent has tools to help:

**Check for imported cookies first** — if the user imported browser data, they may already have Nango session cookies:
```
eval({
  code: `
    import { browserData } from "@workspace/panel-browser";
    const cookies = await browserData.getCookies("nango.dev");
    const hasCookies = cookies.length > 0;
    console.log(hasCookies
      ? "Found Nango cookies — can use browser panel for setup"
      : "No Nango cookies — user should sign up via system browser or import cookies first");
    return { hasCookies };
  `,
  timeout: 5000
})
```

**If cookies available** — open Nango dashboard in a browser panel (with Playwright for automation):
```
eval({
  code: `
    import { createBrowserPanel } from "@workspace/runtime";
    const panel = await createBrowserPanel("https://app.nango.dev");
    console.log("Opened Nango dashboard — guide user through provider setup");
  `,
  timeout: 10000
})
```

**If no cookies** — offer the user a choice: import browser data first (for seamless panel-based setup) or use their system browser directly. Use a `feedback_form` to let them decide.

**After the user gets their secret key** — help them save it:
```
eval({
  code: `
    import { fs } from "@workspace/runtime";
    // Read existing secrets, add nango key, write back
    const secretsPath = "~/.config/natstack/.secrets.yml";
    // Guide user to paste their key, then save it
    console.log("Add this line to " + secretsPath + ":");
    console.log("  nango: sk-your-secret-key-here");
    console.log("Then restart the workspace.");
  `,
  timeout: 5000
})
```

### Choosing how to sign in

When connecting to an OAuth provider, the agent should consider whether to use the NatStack browser panel (with imported cookies/autofill) or the system browser (with existing sessions). See the `openIn` option in the OAuth flow summary below.

## The Spectrum

| Level | When | Example |
|-------|------|---------|
| **Quick eval** | One-off queries, experimentation | `import { Client } from "@notionhq/client"; ...` |
| **Integration module** | Reusable across sessions | Add to `@workspace/integrations` |
| **Dedicated panel** | Needs its own UI | `panels/notion/` with inbox, search, etc. |

Most API work starts at level 1 and stays there. Only graduate to higher levels when you need to.

## Quick Eval: OAuth + npm SDK

The fastest path to any API: get an OAuth token, install the official SDK, use it.

### Step 1: Connect (one-time)

```
eval({
  code: `
    import { oauth } from "@workspace/runtime";

    // Check what providers are available
    const providers = await oauth.listProviders();
    console.log("Available:", providers.map(p => p.key));

    // Connect to one (triggers consent notification + browser sign-in)
    await oauth.connect("notion");
  `,
  timeout: 60000
})
```

After the user approves and signs in, the connection persists. You won't need to call `connect` again.

### Step 2: Use the API with the official SDK

```
eval({
  code: `
    import { oauth } from "@workspace/runtime";
    import { Client } from "@notionhq/client";

    const token = await oauth.getToken("notion");
    const notion = new Client({ auth: token.accessToken });

    const results = await notion.search({ query: "tasks due this week" });
    for (const page of results.results) {
      if (page.object === "page") {
        console.log("-", page.properties?.Name?.title?.[0]?.text?.content ?? page.id);
      }
    }
  `,
  imports: { "@notionhq/client": "npm:^2.2.0" },
  timeout: 30000
})
```

That's it. The npm SDK handles request formatting, pagination, types. OAuth handles token refresh. No raw URL construction needed.

### More examples

**Slack** (post a message):
```
eval({
  code: `
    import { oauth } from "@workspace/runtime";
    import { WebClient } from "@slack/web-api";

    const token = await oauth.getToken("slack");
    const slack = new WebClient(token.accessToken);
    await slack.chat.postMessage({ channel: "#engineering", text: "Deploy complete!" });
    console.log("Posted to #engineering");
  `,
  imports: { "@slack/web-api": "npm:^7" },
  timeout: 30000
})
```

**GitHub** (list PRs):
```
eval({
  code: `
    import { oauth } from "@workspace/runtime";
    import { Octokit } from "octokit";

    const token = await oauth.getToken("github");
    const gh = new Octokit({ auth: token.accessToken });
    const { data: prs } = await gh.rest.pulls.list({ owner: "myorg", repo: "myapp", state: "open" });
    for (const pr of prs) console.log(\`#\${pr.number} \${pr.title}\`);
  `,
  imports: { "octokit": "npm:^4" },
  timeout: 30000
})
```

**Linear** (list assigned issues):
```
eval({
  code: `
    import { oauth } from "@workspace/runtime";
    import { LinearClient } from "@linear/sdk";

    const token = await oauth.getToken("linear");
    const linear = new LinearClient({ accessToken: token.accessToken });
    const me = await linear.viewer;
    const issues = await me.assignedIssues();
    for (const issue of issues.nodes) {
      console.log(\`[\${issue.state?.name}] \${issue.identifier}: \${issue.title}\`);
    }
  `,
  imports: { "@linear/sdk": "npm:^26" },
  timeout: 30000
})
```

### When there's no npm SDK

Fall back to `fetch()` with the OAuth token:

```
eval({
  code: `
    import { oauth } from "@workspace/runtime";
    const token = await oauth.getToken("some-provider");
    const res = await fetch("https://api.example.com/v1/data", {
      headers: { Authorization: \`Bearer \${token.accessToken}\` }
    });
    console.log(await res.json());
  `,
  timeout: 30000
})
```

## Discovering available providers

```
eval({
  code: `
    import { oauth } from "@workspace/runtime";

    const providers = await oauth.listProviders();
    console.log("Configured providers:", providers);

    const connections = await oauth.listConnections();
    console.log("Active connections:", connections);
  `,
  timeout: 10000
})
```

If no providers are configured, guide the user through the setup in the Prerequisites section above. If a specific provider isn't available, they need to enable it in their Nango dashboard (https://app.nango.dev).

## Pre-built integrations

For Gmail and Calendar, pre-built wrappers exist that handle message parsing, MIME encoding, etc.:

```
eval({
  code: `
    import { gmail, calendar } from "@workspace/integrations";
    const messages = await gmail.search("from:alice", 5);
    for (const m of messages) console.log(m.subject, "-", m.from);
    const events = await calendar.listEvents({ maxResults: 5 });
    for (const e of events) console.log(e.summary, e.start);
  `,
  timeout: 30000
})
```

For other APIs, use the npm SDK approach above — it's just as concise and you get the full SDK.

## Creating a reusable integration module

If you find yourself repeating the same API patterns, add a module to `@workspace/integrations`:

1. Create `workspace/packages/integrations/src/notion.ts`
2. Export high-level functions that wrap the SDK + oauth
3. Re-export from `workspace/packages/integrations/src/index.ts`
4. Commit and push

Example pattern:
```ts
// workspace/packages/integrations/src/notion.ts
import { oauth } from "@workspace/runtime";

// Lazy-load the SDK (it's an npm dependency, not a workspace package)
async function getClient() {
  const token = await oauth.getToken("notion");
  const { Client } = await import("@notionhq/client");
  return new Client({ auth: token.accessToken });
}

export async function search(query: string) {
  const notion = await getClient();
  return notion.search({ query });
}

export async function ensureConnected() {
  const conn = await oauth.getConnection("notion");
  if (conn.connected) return;
  const { consented } = await oauth.requestConsent("notion");
  if (!consented) throw new Error("OAuth consent denied for Notion");
  await oauth.startAuth("notion");
  await oauth.waitForConnection("notion");
}
```

## Creating a dedicated panel

When an API needs its own UI (inbox, calendar, kanban board), create a panel:

```
eval({
  code: `
    import { createProject } from "@workspace-skills/paneldev";
    await createProject({ projectType: "panel", name: "notion", title: "Notion" });
  `,
  timeout: 30000
})
```

Then use the same OAuth + SDK pattern in the panel code. Add `@workspace/integrations` as a dependency if you built a reusable module, or use the npm SDK directly.

## OAuth flow summary

All methods accept an optional `connectionId` (defaults to `"default-{provider}"`).

| Step | What happens | User sees |
|------|-------------|-----------|
| `oauth.connect(provider, connId?, { scopes?, openIn? })` | All-in-one: consent + auth + wait → `OAuthConnection` | Notification bar → browser sign-in |
| `oauth.requestConsent(provider, { scopes? })` | Just consent → `{ consented }` | Notification bar with Approve/Deny |
| `oauth.startAuth(provider, connId?, { openIn? })` | Syncs cookies, opens sign-in → `{ authUrl }` | Browser panel or system browser |
| `oauth.waitForConnection(provider, connId?, timeoutMs?)` | Polls until connected → `OAuthConnection` | (agent waits) |
| `oauth.getToken(provider, connId?)` | Returns cached/refreshed token → `{ accessToken, expiresAt, scopes }` | (invisible) |

### `openIn` option

Controls where the sign-in page opens. Applies to `connect()` and `startAuth()`.

| Value | Behavior | Best for |
|-------|----------|----------|
| `"panel"` (default) | NatStack browser panel | Imported cookies + autofill available |
| `"external"` | System browser | User is already signed in there |

**When to offer a choice:** If the user has imported browser cookies/passwords (via the browser-import skill), `"panel"` gives the best experience — the sign-in page may already be authenticated. If they haven't imported browser data, `"external"` is often smoother since they're likely already signed in there.

Ask the user which they prefer using a `feedback_form`:

```
feedback_form({
  title: "Open sign-in page",
  fields: [
    { name: "openIn", type: "select", label: "Where to sign in?",
      options: [
        { value: "panel", label: "NatStack browser (imported cookies + autofill)" },
        { value: "external", label: "System browser (existing sessions)" }
      ] }
  ],
  values: { openIn: "panel" }
})
```

Then pass the result: `await oauth.connect("google-mail", undefined, { openIn: result.openIn })`.

Imported browser cookies are synced before auth, so if the user imported Chrome cookies with an active session, the NatStack browser panel will already be logged in.

## Self-hosted Nango

By default, OAuth uses Nango Cloud (`https://api.nango.dev`). To use a self-hosted Nango instance, add this to `natstack.yml`:

```yaml
oauth:
  nangoUrl: https://your-nango-instance.example.com
```

The secret key still goes in `~/.config/natstack/.secrets.yml` as `nango: sk-...`.

## Limitations

- Only providers enabled in your Nango dashboard work with `oauth.*`. Check `oauth.listProviders()`.
- Interactive OAuth (`connect`, `startAuth`) must be called from a panel context, not from workers. Workers should use `getToken()` after the user has connected via a panel.
- npm packages with native addons (`.node` files) can't be bundled — pure JS/TS only.
- First npm install takes 10-30s. Use `timeout: 30000` or higher.
- CORS is disabled for app panels, so `fetch()` works directly for any URL.

## Environment Compatibility

- Core API integration features (`oauth.getToken`, `oauth.listProviders`, SDK usage via eval) work in **headless** sessions.
- `feedback_form` for sign-in choice and interactive OAuth (`oauth.connect`, `oauth.startAuth`) are **panel-only**.
- Headless agents should use `getToken()` after the user has connected via a panel.
