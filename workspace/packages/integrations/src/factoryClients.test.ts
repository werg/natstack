import type { RpcCaller } from "@natstack/rpc";
import { createCredentialClient, type StoredCredentialSummary } from "@workspace/runtime/credentials";
import { createGitHubClient } from "./github.js";
import { createGmailClient } from "./gmail.js";
import { createCalendarClient } from "./calendar.js";

/**
 * Build a mock RPC caller that:
 *   - Resolves any audience to a single stub credential (so
 *     `forAudience` succeeds the first time it's called).
 *   - Routes proxyFetch through a recorded fetcher that returns
 *     whatever `respond(url, init)` decides.
 *
 * Also tracks how many times each method is called so we can assert
 * the per-context memoization of the credential handle.
 */
function makeMockEnv(
  respond: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Response,
) {
  const stats = {
    resolveCalls: 0,
    fetchCalls: [] as Array<{ url: string; method: string }>,
  };
  const credential: StoredCredentialSummary = {
    id: "cred-mock",
    label: "Mock",
    providerId: "mock",
    accountIdentity: { providerUserId: "mock" },
    audience: [],
    injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
    bindings: [],
    scopes: [],
    metadata: {},
    createdAt: Date.now(),
  } as unknown as StoredCredentialSummary;

  const rpc: RpcCaller = {
    call: (async <T = unknown>(_targetId: string, method: string, _args: unknown[]): Promise<T> => {
      if (method === "credentials.resolveCredential") {
        stats.resolveCalls++;
        return credential as unknown as T;
      }
      throw new Error(`unexpected method: ${method}`);
    }) as RpcCaller["call"],
    streamCall: async (_target: string, method: string, args: unknown[]) => {
      if (method !== "credentials.proxyFetch") {
        throw new Error(`unexpected streamCall method: ${method}`);
      }
      const params = args[0] as {
        url: string;
        method: string;
        headers?: Record<string, string>;
        body?: string;
      };
      stats.fetchCalls.push({ url: params.url, method: params.method });
      return respond(params.url, params);
    },
  };
  const credentials = createCredentialClient(rpc);
  return { credentials, stats };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createGitHubClient", () => {
  it("memoizes the credential handle across method calls", async () => {
    const { credentials, stats } = makeMockEnv((url) => {
      if (url.endsWith("/user")) return jsonResponse({ login: "octocat", id: 1 });
      if (url.endsWith("/user/repos")) return jsonResponse([{ id: 1, name: "spoon-knife", full_name: "octocat/spoon-knife" }]);
      return jsonResponse({}, { status: 404 });
    });
    const github = createGitHubClient(credentials);

    const user = await github.getUser();
    const repos = await github.listRepos();

    expect(user.login).toBe("octocat");
    expect(repos).toHaveLength(1);
    // Credential resolution happened exactly once even though two
    // methods were called — that's the memoization promise.
    expect(stats.resolveCalls).toBe(1);
  });

  it("constructs the right paths for issue methods", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({ number: 7, title: "test", state: "open", html_url: "x", id: 1 }),
    );
    const github = createGitHubClient(credentials);

    await github.getIssue("owner", "repo", 7);
    await github.updateIssue("owner", "repo", 7, { state: "closed" });
    await github.createIssue("owner", "repo", { title: "new" });

    const paths = stats.fetchCalls.map((c) => c.url);
    expect(paths).toEqual([
      "https://api.github.com/repos/owner/repo/issues/7",
      "https://api.github.com/repos/owner/repo/issues/7",
      "https://api.github.com/repos/owner/repo/issues",
    ]);
    expect(stats.fetchCalls.map((c) => c.method)).toEqual(["GET", "PATCH", "POST"]);
  });

  it("throws a typed error on non-2xx responses", async () => {
    const { credentials } = makeMockEnv(() =>
      new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const github = createGitHubClient(credentials);

    await expect(github.getUser()).rejects.toThrow(/GitHub API request failed: 403 Forbidden/);
  });
});

describe("createGmailClient", () => {
  it("memoizes the credential handle across method calls", async () => {
    const { credentials, stats } = makeMockEnv((url) => {
      if (url.endsWith("/profile")) return jsonResponse({ emailAddress: "a@b.com", historyId: "100" });
      if (url.endsWith("/labels")) return jsonResponse({ labels: [{ id: "INBOX", name: "INBOX" }] });
      return jsonResponse({});
    });
    const gmail = createGmailClient(credentials);

    await gmail.getProfile();
    await gmail.listLabels();
    await gmail.getProfile();

    expect(stats.resolveCalls).toBe(1);
    expect(stats.fetchCalls).toHaveLength(3);
  });

  it("encodes search queries via listMessages", async () => {
    const { credentials, stats } = makeMockEnv(() => jsonResponse({ messages: [] }));
    const gmail = createGmailClient(credentials);

    await gmail.search("from:boss subject:report");

    expect(stats.fetchCalls).toHaveLength(1);
    expect(stats.fetchCalls[0]!.url).toContain("q=from%3Aboss");
  });
});

describe("factory client retry semantics", () => {
  it("retries credential resolution after a failed first call", async () => {
    // Mid-session credential registration: first call fails (no
    // credential), user registers one, next call should succeed.
    let credentialRegistered = false;
    const credential: StoredCredentialSummary = {
      id: "later",
      label: "Later",
      providerId: "test",
      accountIdentity: { providerUserId: "x" },
      audience: [],
      injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
      bindings: [],
      scopes: [],
      metadata: {},
      createdAt: Date.now(),
    } as unknown as StoredCredentialSummary;

    const rpc: RpcCaller = {
      call: (async <T = unknown>(_t: string, method: string): Promise<T> => {
        if (method === "credentials.resolveCredential") {
          return (credentialRegistered ? credential : null) as unknown as T;
        }
        throw new Error(`unexpected method: ${method}`);
      }) as RpcCaller["call"],
      streamCall: async () => jsonResponse({ login: "u", id: 1 }),
    };
    const github = createGitHubClient(createCredentialClient(rpc));

    // First call rejects.
    await expect(github.getUser()).rejects.toThrow(/No URL-bound credential found/);

    // Register credential mid-session.
    credentialRegistered = true;

    // Second call must succeed — the factory must NOT cache the
    // rejected promise from the first attempt.
    const user = await github.getUser();
    expect(user.login).toBe("u");
  });
});

describe("createGmailClient header injection", () => {
  it("rejects CR/LF in Subject", async () => {
    const { credentials } = makeMockEnv(() => jsonResponse({}));
    const gmail = createGmailClient(credentials);
    await expect(
      gmail.sendMessage({
        to: "a@b.com",
        subject: "Hello\r\nBcc: attacker@evil.com",
        body: "x",
      }),
    ).rejects.toThrow(/header injection rejected/);
  });

  it("rejects newlines in To", async () => {
    const { credentials } = makeMockEnv(() => jsonResponse({}));
    const gmail = createGmailClient(credentials);
    await expect(
      gmail.sendMessage({
        to: "a@b.com\nBcc: attacker@evil.com",
        subject: "ok",
        body: "x",
      }),
    ).rejects.toThrow(/header injection rejected/);
  });

  it("rejects invalid header names in params.headers", async () => {
    const { credentials } = makeMockEnv(() => jsonResponse({}));
    const gmail = createGmailClient(credentials);
    await expect(
      gmail.sendMessage({
        to: "a@b.com",
        subject: "ok",
        body: "x",
        headers: { "X-Bad\r\nInject": "y" },
      }),
    ).rejects.toThrow(/invalid header name/);
  });
});

describe("createCalendarClient", () => {
  it("memoizes the credential handle across method calls", async () => {
    const { credentials, stats } = makeMockEnv(() =>
      jsonResponse({ items: [{ id: "primary", summary: "Primary" }] }),
    );
    const cal = createCalendarClient(credentials);

    await cal.listCalendars();
    await cal.listEvents("primary");
    await cal.listCalendars();

    expect(stats.resolveCalls).toBe(1);
  });

  it("returns 204 deletions as undefined", async () => {
    const { credentials } = makeMockEnv(() => new Response(null, { status: 204 }));
    const cal = createCalendarClient(credentials);

    await expect(cal.deleteEvent("primary", "evt-1")).resolves.toBeUndefined();
  });
});
