---
name: web-research
description: Search the open web and read pages with the web_search, web_fetch, and web_read tools. Use for fresh information, citations, or anything outside the workspace and the model's training cutoff.
---

# Web Research

You have three tools for reaching the open web. They are read-only and
auto-approve at approval level 1 (the default for most workspaces).

## Tools

### web_search

```
web_search({ query: string, max_results?: number })  →  { title, url, snippet }[]
```

Discovery. Returns ranked results from DuckDuckGo (zero-config), or one
of three keyed providers (Tavily, Brave, Exa) when the user has
registered a credential for one through the app's credentials system.

- Default `max_results` is 5; allowed range 1–20.
- Snippets are short — use them only to pick a URL, not to answer the
  question. Always follow up with `web_fetch` on the best result.
- Provider preference is fixed: **Tavily > Brave > Exa > DuckDuckGo**.
  The tool selects the first one whose credential is registered. See
  the *Upgrading the search provider* section below if DDG is failing
  or you want longer snippets.

### web_fetch

```
web_fetch({ url: string })  →  { url, title, digest, size, head }
```

Fetches a URL, extracts the main content with Mozilla Readability, converts
to markdown, **stores the full markdown in the blobstore**, and returns:

- `url` — the final URL after redirects
- `title` — the extracted article title
- `digest` — a sha256 digest you can pass to `web_read`
- `size` — total markdown size in bytes
- `head` — the first ~5000 chars of the markdown, inline in the tool output

If `head` already contains the answer, you're done — cite the URL and reply.
If not, drill in with `web_read`.

### web_read

```
web_read({ digest: string, offset?: number, limit?: number })  →  string
```

Reads a byte range from a previously-cached page. The blobstore is content-
addressed and persistent across the session, so re-reading is free — no
network round-trip.

- `offset` defaults to 0; `limit` defaults to 8000 chars (max 32000).
- Walk a long page by issuing successive `web_read` calls with growing
  offsets, or jump near where you think the answer is.

## Typical workflow

1. `web_search({ query: "..." })` — get a small list of candidate URLs.
2. Pick one (or two) and `web_fetch({ url })`. Look at the `head`.
3. If `head` answers the question → write the reply, cite the URL.
4. If not → `web_read({ digest, offset, limit })` further into the
   cached page. Re-issue with bigger offsets until you find what you need.
5. Reply with the answer plus the source URL(s).

## Grepping inside a cached page (eval)

For pages too long to page through, grep the cached blob directly via
the blobstore RPC inside `eval`. The grep runs server-side — only the
matching lines come back to the worker:

```
eval({ code: `
  const matches = await rpc.call("main", "blobstore.grep",
    "<digest from web_fetch>",
    "section 7",                // regex pattern
    { caseInsensitive: true, contextLines: 2, maxMatches: 10 }
  );
  return matches;
` })
```

Returns `Array<{ lineNumber, line, before: string[], after: string[] }>`,
or `null` if the digest is unknown. Useful when:

- you know roughly what you're looking for but not where it is
- you want to scan a long doc for multiple terms in one call (loop
  over patterns inside eval)
- the page is too large to walk with `web_read` offsets

## Composing in eval

Anything more advanced — batch-fetching multiple URLs, post-processing
results, scoring snippets — belongs in `eval`. The tools above are the
fast path; eval is the full toolbox.

## Targeted search recipes (eval)

For coding questions, a domain-specific API is usually higher signal
than general web search. All of these work with no API key.

### GitHub code search

```
eval({ code: `
  const r = await fetch("https://api.github.com/search/code?q=" +
    encodeURIComponent("queryName:foo language:typescript"));
  const data = await r.json();
  return data.items.slice(0, 5).map(i => ({
    repo: i.repository.full_name,
    path: i.path,
    url: i.html_url,
  }));
` })
```

GitHub returns 422 if you query without authentication; for unauthenticated
searches, set `Accept: application/vnd.github.text-match+json` and use the
public `/search/repositories` or `/search/code` endpoints. Tighter queries
(`org:`, `repo:`, `language:`, `path:`) are far more useful than fuzzy ones.

### Stack Overflow

```
eval({ code: `
  const r = await fetch(
    "https://api.stackexchange.com/2.3/search/advanced?" +
    new URLSearchParams({
      order: "desc", sort: "votes", site: "stackoverflow",
      q: "your question here", pagesize: "5",
    }));
  const data = await r.json();
  return data.items.map(q => ({
    title: q.title, url: q.link, score: q.score, answered: q.is_answered,
  }));
` })
```

### npm

```
eval({ code: `
  const r = await fetch("https://registry.npmjs.org/-/v1/search?" +
    new URLSearchParams({ text: "fastify auth", size: "5" }));
  const data = await r.json();
  return data.objects.map(o => ({
    name: o.package.name,
    description: o.package.description,
    version: o.package.version,
    url: o.package.links.npm,
  }));
` })
```

### MDN

MDN has no documented search API; use `web_search` for it (DDG ranks MDN
pages highly for JS/CSS terms). If you need the page content, `web_fetch`
the result URL — MDN pages extract cleanly with Readability.

## PDFs

`web_fetch` handles PDFs natively — point it at a `.pdf` URL and you get
markdown back with the extracted text broken into `## Page N` sections,
just like an HTML page. The `content_type` field in the tool details
will be `"pdf"`. Use `web_read` and the eval grep recipe above on the
resulting digest just like any other cached page.

For images-only / scanned PDFs that have no embedded text, drop into
eval and pass the raw bytes to a vision-capable model.

## Paywalled / logged-in pages (eval + browser panel)

`web_fetch` is a bare HTTP GET — it has no cookies, no JavaScript
execution, and no user session. For paywalled articles, sites that
require login, or apps that need client-side rendering, route the
fetch through a real browser panel instead:

`openPanel`/`panelTree` are part of the portable runtime surface from
`@workspace/runtime`; they work from server-side eval, panels, workers, and DOs.
The `handle.cdp.lightweightPage()` automation is workerd-native and runs over a
WebSocket to the panel's CDP endpoint, so a browser panel opened from eval can be
driven there directly:

```tsx
import { openPanel } from "@workspace/runtime";
import { htmlToReadableMarkdown } from "@workspace/harness/web-extract";

const browser = await openPanel("https://example.com/article");
const page = await browser.cdp.lightweightPage();
await page.waitForLoadState("networkidle");
const html = await page.content();
const { title, markdown } = htmlToReadableMarkdown(html, page.url());
const { digest, size } = await rpc.call("main", "blobstore.putText", [markdown]);
// The panel stays open by default; close it (or hand it back) when done:
// await browser.close();
const result = { title, digest, size, head: markdown.slice(0, 5000) };
```

The blob you get back is indistinguishable from a `web_fetch` blob —
`web_read` and `blobstore.grep` work on it the same way. The user's
existing session in the browser panel (any prior logins, cookies) is
used automatically.

When to use this over `web_fetch`:

- **Use first**: `web_fetch` — fast, cheap, works for ~95% of pages.
- **Fall back to the browser recipe** when:
  - `web_fetch` returns a head shorter than ~300 chars (likely a paywall
    or a JS-rendered SPA shell)
  - the page is gated behind a login the user has set up in the panel
  - the page only finishes rendering after JS runs (Twitter, Notion,
    Linear, etc.)

The recipe opens a real Electron panel, so be sparing — don't loop
over 50 URLs this way. For batch crawls, prefer `web_fetch` and accept
the partial results.

For login flows or interactive pages, see the `sandbox` skill's
`BROWSER_AUTOMATION.md` for the Playwright-style page API on the lightweight CDP
client.

## Summarizing long pages with an aux model (eval)

When a page is too long to read entirely, summarize it in eval using a
cheap fast model — your worker's API surface usually exposes a chat call:

```
eval({ code: `
  // Pull the full markdown by digest
  const md = await rpc.call("main", "blobstore.getText", ["<digest>"]);
  // Then ask a fast model to summarize it
  // (exact import depends on your workspace; check the api-integrations skill)
  // ... return the summary
` })
```

## When to use which

- **Workspace question** → use file tools (`read`, `grep`) on the workspace,
  not web tools.
- **Specific URL the user gave you** → go straight to `web_fetch`, skip search.
- **Fresh or external knowledge** (news, library docs, API references,
  current events) → start with `web_search`.
- **Verifying or quoting** a fact → fetch the source, cite its URL.

## Upgrading the search provider

DuckDuckGo works without setup but rate-limits under load and ships
short snippets. Tavily / Brave / Exa give cleaner, longer results.
**Provider keys live in the app's encrypted credentials system, not in
environment variables or settings files** — register them with the
helpers below and the credentialed fetcher injects auth automatically
when `web_search` calls the provider URL.

```
eval({ code: `
  import { requestTavilyApiKey } from "@workspace-skills/web-research";
  // Pops the trusted credential-input dialog. The user pastes their key
  // and it's stored encrypted, bound to https://api.tavily.com/. The
  // agent never sees the key value — subsequent web_search calls are
  // routed through Tavily automatically.
  await requestTavilyApiKey();
` })
```

Same shape for Brave and Exa:

```
import { requestBraveApiKey, requestExaApiKey } from "@workspace-skills/web-research";
await requestBraveApiKey();
await requestExaApiKey();
```

Check what's currently active without making a search call:

```
import { getActiveSearchProvider, listSearchProviderCredentials }
  from "@workspace-skills/web-research";
await getActiveSearchProvider();       // "tavily" | "brave" | "exa" | "duckduckgo"
await listSearchProviderCredentials(); // full credential summaries
```

Revoke one:

```
import { revokeSearchProviderCredential } from "@workspace-skills/web-research";
await revokeSearchProviderCredential(credentialId);
```

**When to suggest an upgrade**: if `web_search` returns a
`DuckDuckGoBlockedError`, returns 0 results twice in a row, or the
user is doing lots of research, mention they can register a Tavily
key — it's the most agent-friendly of the three. Don't ask for the
key in chat — call `requestTavilyApiKey()` and let the user paste it
into the trusted approval UI.

## Notes

- The cache is content-addressed: the same page fetched twice produces the
  same digest, so digests from earlier in the session are still valid.
- Pages with paywalls, login walls, or heavy client-side rendering may
  return mostly empty markdown. If `head` is shorter than expected, mention
  that to the user rather than fabricating content.
