import { githubCredential } from "./providers.js";
import { getUrlCredentialClient, type UrlCredentialClient } from "./urlCredentialClient.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";

export const manifest = {
  scopes: {
    github: ["repo", "read_user"],
  },
  endpoints: {
    github: [
      { url: "https://api.github.com/user", methods: ["GET"] },
      { url: "https://api.github.com/repos/*", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
      { url: "https://api.github.com/repos/*/issues/*", methods: ["GET", "PATCH"] },
      { url: "https://api.github.com/repos/*/pulls", methods: ["GET"] },
      { url: "https://api.github.com/repos/*/pulls/*", methods: ["GET"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues", deliver: "onIssue" },
      { event: "pull_request", deliver: "onPullRequest" },
    ],
  },
} as const;

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
  type: string;
  name?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: GitHubUser;
  html_url: string;
  description?: string | null;
  default_branch?: string;
  [key: string]: unknown;
}

export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
  description?: string | null;
  [key: string]: unknown;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  body?: string | null;
  user?: GitHubUser;
  assignees?: GitHubUser[];
  labels?: Array<GitHubLabel | string>;
  repository_url?: string;
  [key: string]: unknown;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  state: string;
  html_url: string;
  title: string;
  body?: string | null;
  user?: GitHubUser;
  [key: string]: unknown;
}

export interface ListReposOptions {
  visibility?: "all" | "public" | "private";
  affiliation?: string;
  type?: "all" | "owner" | "member";
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
  per_page?: number;
  page?: number;
}

export interface ListIssuesOptions {
  milestone?: string;
  state?: "open" | "closed" | "all";
  assignee?: string;
  creator?: string;
  mentioned?: string;
  labels?: string | string[];
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  since?: string;
  per_page?: number;
  page?: number;
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  assignees?: string[];
  milestone?: number;
  labels?: string[];
}

export interface GitHubIssueWebhookEvent {
  action?: string;
  issue?: GitHubIssue;
  repository?: GitHubRepo;
  sender?: GitHubUser;
  [key: string]: unknown;
}

export interface GitHubPullRequestWebhookEvent {
  action?: string;
  number?: number;
  pull_request?: GitHubPullRequest;
  repository?: GitHubRepo;
  sender?: GitHubUser;
  [key: string]: unknown;
}

function toQueryParams(params?: object): string {
  if (!params) {
    return "";
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    search.set(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : "";
}

async function githubFetch<T>(
  path: string,
  init?: RequestInit,
  auth?: UrlCredentialClient,
): Promise<T> {
  const handle = auth ?? await ensureAuth();
  const headers = new Headers(init?.headers);
  headers.set("Accept", GITHUB_ACCEPT_HEADER);

  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await handle.fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`,
    );
  }

  return await response.json() as T;
}

let github: UrlCredentialClient | undefined;

async function ensureAuth(): Promise<UrlCredentialClient> {
  if (!github) {
    github = await getUrlCredentialClient(githubCredential);
  }
  return github;
}

export async function getUser(auth?: UrlCredentialClient): Promise<GitHubUser> {
  return githubFetch<GitHubUser>("/user", undefined, auth);
}

export async function listRepos(
  auth?: UrlCredentialClient,
  opts?: ListReposOptions,
): Promise<GitHubRepo[]> {
  return githubFetch<GitHubRepo[]>(
    `/user/repos${toQueryParams(opts)}`,
    undefined,
    auth,
  );
}

export async function getRepo(
  owner: string,
  repo: string,
  auth?: UrlCredentialClient,
): Promise<GitHubRepo> {
  return githubFetch<GitHubRepo>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    undefined,
    auth,
  );
}

export async function listIssues(
  owner: string,
  repo: string,
  opts?: ListIssuesOptions,
  auth?: UrlCredentialClient,
): Promise<GitHubIssue[]> {
  const labels = Array.isArray(opts?.labels) ? opts.labels.join(",") : opts?.labels;
  return githubFetch<GitHubIssue[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${toQueryParams({
      ...opts,
      labels,
    })}`,
    undefined,
    auth,
  );
}

export async function createIssue(
  owner: string,
  repo: string,
  params: CreateIssueParams,
  auth?: UrlCredentialClient,
): Promise<GitHubIssue> {
  return githubFetch<GitHubIssue>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: "POST",
      body: JSON.stringify(params),
    },
    auth,
  );
}

export async function getIssue(
  owner: string,
  repo: string,
  number: number,
  auth?: UrlCredentialClient,
): Promise<GitHubIssue> {
  return githubFetch<GitHubIssue>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    undefined,
    auth,
  );
}

export function onIssue(event: GitHubIssueWebhookEvent) {
  return {
    type: "issues" as const,
    action: event.action ?? null,
    issue: event.issue ?? null,
    repository: event.repository ?? null,
    sender: event.sender ?? null,
    raw: event,
  };
}

export function onPullRequest(event: GitHubPullRequestWebhookEvent) {
  return {
    type: "pull_request" as const,
    action: event.action ?? null,
    number: event.number ?? event.pull_request?.number ?? null,
    pullRequest: event.pull_request ?? null,
    repository: event.repository ?? null,
    sender: event.sender ?? null,
    raw: event,
  };
}
