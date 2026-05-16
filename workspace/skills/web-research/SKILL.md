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

Discovery. Returns ranked results from DuckDuckGo (zero-config), or
Tavily when the user has set `TAVILY_API_KEY` in their environment.

- Default `max_results` is 5; allowed range 1–20.
- Snippets are short — use them only to pick a URL, not to answer the
  question. Always follow up with `web_fetch` on the best result.

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

## Fetching and parsing PDFs (eval)

`web_fetch` currently expects HTML or plain text; for PDFs, fetch the
bytes, drop them in the blobstore, then parse with a worker-side library
or summarize the binary directly with a vision-capable model:

```
eval({ code: `
  const res = await fetch("https://arxiv.org/pdf/2401.12345.pdf");
  const buf = new Uint8Array(await res.arrayBuffer());
  const b64 = btoa(String.fromCharCode(...buf));
  // Store the raw PDF so we don't re-download it
  const { digest, size } = await rpc.call("main", "blobstore.putBase64", b64);
  return { digest, size };
` })
```

PDF→text parsing depends on what packages your project allows. For
short PDFs, asking a vision-capable model to read the bytes works well;
for long PDFs, run pdf.js/pdfminer in a separate worker.

## Summarizing long pages with an aux model (eval)

When a page is too long to read entirely, summarize it in eval using a
cheap fast model — your worker's API surface usually exposes a chat call:

```
eval({ code: `
  // Pull the full markdown by digest
  const md = await rpc.call("main", "blobstore.getText", "<digest>");
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

## Notes

- DuckDuckGo can occasionally rate-limit under heavy use. If `web_search`
  starts returning empty results or errors, tell the user they can set
  `TAVILY_API_KEY` in the worker env for a higher-quality, keyed provider.
- The cache is content-addressed: the same page fetched twice produces the
  same digest, so digests from earlier in the session are still valid.
- Pages with paywalls, login walls, or heavy client-side rendering may
  return mostly empty markdown. If `head` is shorter than expected, mention
  that to the user rather than fabricating content.
