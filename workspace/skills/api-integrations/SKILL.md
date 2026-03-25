# API Integrations

How to connect to and use third-party APIs (Gmail, Notion, Slack, GitHub, etc.) from agent eval code.

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

    // See what providers are configured in Nango
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

    // What providers are configured in Nango?
    const providers = await oauth.listProviders();
    console.log("Configured providers:", providers);

    // What connections are already active?
    const connections = await oauth.listConnections();
    console.log("Active connections:", connections);
  `,
  timeout: 10000
})
```

If a provider isn't configured, tell the user they need to add it in their Nango dashboard first.

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
  imports: { "@workspace/integrations": "latest" },
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
  await oauth.requestConsent("notion");
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
  imports: { "@workspace-skills/paneldev": "latest" },
  timeout: 30000
})
```

Then use the same OAuth + SDK pattern in the panel code. Add `@workspace/integrations` as a dependency if you built a reusable module, or use the npm SDK directly.

## OAuth flow summary

All methods accept an optional `connectionId` (defaults to `"default-{provider}"`).

| Step | What happens | User sees |
|------|-------------|-----------|
| `oauth.connect(provider, connId?, { scopes? })` | All-in-one: consent + auth + wait → `OAuthConnection` | Notification bar → browser sign-in |
| `oauth.requestConsent(provider, { scopes? })` | Just consent → `{ consented }` | Notification bar with Approve/Deny |
| `oauth.startAuth(provider, connId?)` | Syncs cookies, opens browser panel → `{ authUrl, browserPanelId? }` | Browser panel with sign-in page |
| `oauth.waitForConnection(provider, connId?, timeoutMs?)` | Polls until connected → `OAuthConnection` | (agent waits) |
| `oauth.getToken(provider, connId?)` | Returns cached/refreshed token → `{ accessToken, expiresAt, scopes }` | (invisible) |

Imported browser cookies are synced before auth, so if the user imported Chrome cookies with an active session, they may already be logged in.

## Limitations

- Only Nango-configured providers work with `oauth.*`. Check `oauth.listProviders()`.
- npm packages with native addons (`.node` files) can't be bundled — pure JS/TS only.
- First npm install takes 10-30s. Use `timeout: 30000` or higher.
- CORS is disabled for app panels, so `fetch()` works directly for any URL.
