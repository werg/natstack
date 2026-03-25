# API Integration

Guide for connecting to external APIs from agent eval — from quick experiments to reusable libraries and full panels.

## Quick reference: what's available

```ts
import { oauth, httpProxy } from "@workspace/runtime";

// See what OAuth providers are configured in Nango
const providers = await oauth.listProviders();
// → ["google-mail", "github", "slack", "notion", ...]

// See which providers the user has already connected
const connections = await oauth.listConnections();
// → [{ id: "default-google-mail", provider: "google-mail", connected: true }]
```

If an integration library already exists for the API, use it directly:

```ts
import { gmail, calendar } from "@workspace/integrations";
// See email-api skill for full docs
```

Otherwise, follow the spectrum below.

---

## The spectrum: quick experiment → reusable library → full panel

### Level 1: Direct API call (30 seconds)

Use `httpProxy.fetch()` for any HTTP API. No OAuth needed if the API uses API keys or is public.

```ts
import { httpProxy } from "@workspace/runtime";

const res = await httpProxy.fetch("https://api.example.com/data", {
  headers: { "Authorization": "Bearer sk-..." },
});
const data = JSON.parse(res.body);
```

Good for: one-off API calls, public APIs, APIs with user-provided keys.

### Level 2: OAuth + httpProxy (2 minutes)

For APIs with Nango OAuth integration. Check available providers first:

```ts
import { oauth, httpProxy } from "@workspace/runtime";

// Check if the provider exists and connect if needed
const conn = await oauth.getConnection("notion");
if (!conn.connected) {
  // This triggers: consent notification → browser panel sign-in
  await oauth.requestConsent("notion", { scopes: ["database:read"] });
  await oauth.startAuth("notion");
  await oauth.waitForConnection("notion");
}

// Now use the token
const token = await oauth.getToken("notion");
const res = await httpProxy.fetch("https://api.notion.com/v1/databases", {
  headers: {
    Authorization: `Bearer ${token.accessToken}`,
    "Notion-Version": "2022-06-28",
  },
});
const databases = JSON.parse(res.body);
```

Good for: exploring an API, one-off queries, prototyping.

### Level 3: Inline wrapper functions (5 minutes)

Write helper functions in eval for repeated use within a session. These are ephemeral — they don't persist between sessions.

```ts
import { oauth, httpProxy } from "@workspace/runtime";

const PROVIDER = "notion";

async function notionFetch(path, opts) {
  const token = await oauth.getToken(PROVIDER);
  const res = await httpProxy.fetch(`https://api.notion.com/v1${path}`, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...opts?.headers,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status >= 400) throw new Error(`Notion API ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

// Now use it
const databases = await notionFetch("/databases");
const pages = await notionFetch("/databases/abc123/query", {
  method: "POST",
  body: { filter: { property: "Status", select: { equals: "In Progress" } } },
});
```

Good for: multi-step workflows in a single session, prototyping before committing to a library.

### Level 4: Integration library (10 minutes)

Create a reusable module in `@workspace/integrations`. This persists and can be imported by any agent or panel.

```ts
import { fs } from "@workspace/runtime";
import { createProject, commitAndPush } from "@workspace-skills/paneldev";

// Write the integration module
await fs.writeFile("/workspace/packages/integrations/src/notion.ts", `
import { oauth, httpProxy } from "@workspace/runtime";

const PROVIDER = "notion";
const BASE = "https://api.notion.com/v1";

async function authedFetch(path, opts) {
  const token = await oauth.getToken(PROVIDER);
  const res = await httpProxy.fetch(BASE + path, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: "Bearer " + token.accessToken,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...opts?.headers,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status >= 400) throw new Error("Notion API " + res.status + ": " + res.body);
  return JSON.parse(res.body);
}

export async function listDatabases() { return authedFetch("/databases"); }
export async function queryDatabase(id, filter) {
  return authedFetch("/databases/" + id + "/query", { method: "POST", body: { filter } });
}
export async function getPage(id) { return authedFetch("/pages/" + id); }
export async function createPage(databaseId, properties) {
  return authedFetch("/pages", { method: "POST", body: { parent: { database_id: databaseId }, properties } });
}
export async function ensureConnected() {
  const conn = await oauth.getConnection(PROVIDER);
  if (conn.connected) return;
  await oauth.requestConsent(PROVIDER, { scopes: ["database:read", "page:write"] });
  await oauth.startAuth(PROVIDER);
  await oauth.waitForConnection(PROVIDER);
}
`);

// Add to index exports
// (read existing index, append export)

// Commit so it's available to other agents/panels
await commitAndPush("workspace/packages/integrations", "Add Notion integration");
```

After commit + rebuild, any agent can:
```ts
import { notion } from "@workspace/integrations";
await notion.ensureConnected();
const databases = await notion.listDatabases();
```

Good for: APIs you'll use repeatedly, sharing across agents and panels.

### Level 5: Full panel (30+ minutes)

Create a dedicated panel with UI for rich interaction. Use the `paneldev` skill:

```ts
import { createProject } from "@workspace-skills/paneldev";
await createProject({
  projectType: "panel",
  name: "notion",
  title: "Notion",
  template: "default",
});
```

Then develop the panel with Read/Write/Edit tools, import from the integration library, add UI components.

Good for: APIs that benefit from visual interaction (browsing, editing, dashboards).

---

## How to choose the right level

| Situation | Level |
|-----------|-------|
| "What does the Notion API return for /databases?" | Level 1-2 |
| "Check my Linear for overdue issues" | Level 2-3 |
| "Set up Slack integration for the workspace" | Level 4 |
| "Build a Notion task board panel" | Level 4 → 5 |
| "Send a quick Slack message" | Level 2 |
| "Create a Gmail workflow that runs daily" | Level 4 + worker |

**Start at the lowest level that works.** Promote to the next level when you need reusability or richer interaction.

---

## OAuth provider discovery

Before attempting OAuth, check what's available:

```ts
import { oauth } from "@workspace/runtime";

// List configured Nango providers
const providers = await oauth.listProviders();

// List active connections
const connections = await oauth.listConnections();
```

If the desired provider isn't listed, tell the user they need to configure it in Nango and add the secret to `.secrets.yml`.

---

## Common patterns

### Authenticated fetch helper

Every integration follows the same pattern:

```ts
async function apiFetch(baseUrl, providerKey, path, opts?) {
  const token = await oauth.getToken(providerKey);
  const res = await httpProxy.fetch(baseUrl + path, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status >= 400) throw new Error(`API error ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}
```

### Pagination

Most APIs paginate. Handle it:

```ts
async function fetchAll(path) {
  let results = [];
  let cursor = undefined;
  do {
    const data = await apiFetch(BASE, PROVIDER, path + (cursor ? `?cursor=${cursor}` : ""));
    results.push(...data.results);
    cursor = data.next_cursor;
  } while (cursor);
  return results;
}
```

### Error handling

```ts
try {
  const data = await apiFetch(BASE, PROVIDER, "/endpoint");
} catch (err) {
  if (err.message.includes("401")) {
    // Token expired or revoked — reconnect
    await oauth.disconnect(PROVIDER);
    await oauth.requestConsent(PROVIDER);
    await oauth.startAuth(PROVIDER);
    await oauth.waitForConnection(PROVIDER);
    // Retry...
  }
}
```
