import { githubCredential } from "./providers.js";
import { getUrlCredentialClient, type UrlCredentialClient } from "./urlCredentialClient.js";

export const manifest = {
  scopes: {
    github: ["repo"],
  },
  endpoints: {
    github: [
      { url: "https://api.github.com/repos/*/issues", methods: ["GET", "POST"] },
      { url: "https://api.github.com/repos/*/issues/*", methods: ["GET", "PATCH"] },
    ],
  },
  webhooks: {
    github: [
      { event: "issues", deliver: "onSourceIssue" },
    ],
  },
} as const;

type GitHubOwner = {
  login?: string;
  name?: string;
};

type GitHubRepository = {
  name: string;
  owner: GitHubOwner;
};

type GitHubUser = {
  login: string;
};

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  user: GitHubUser;
  pull_request?: unknown;
};

type SourceIssueEvent = {
  action: string;
  issue: GitHubIssue;
  repository: GitHubRepository;
  // The integration host can inject the mirror destination alongside the GitHub webhook payload.
  targetOwner: string;
  targetRepo: string;
};

type MirrorIssueParams = {
  sourceOwner: string;
  sourceRepo: string;
  issueNumber: number;
  targetOwner: string;
  targetRepo: string;
};

type MirrorIssueResult = {
  source: {
    owner: string;
    repo: string;
    issueNumber: number;
  };
  target: {
    owner: string;
    repo: string;
    issueNumber: number;
    created: boolean;
    url: string;
  };
};

type MirrorLookupIssue = {
  number: number;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
};

type CreateOrUpdateIssuePayload = {
  title: string;
  body: string;
  state: "open" | "closed";
};

const GITHUB_API_FALLBACK = "https://api.github.com";

export async function onSourceIssue(event: SourceIssueEvent): Promise<MirrorIssueResult | { skipped: true; reason: string }> {
  if (!shouldMirrorAction(event.action)) {
    return {
      skipped: true,
      reason: `Unsupported action: ${event.action}`,
    };
  }

  const sourceOwner = getRepositoryOwner(event.repository);
  if (!sourceOwner) {
    throw new Error("Webhook payload is missing repository.owner.login");
  }

  if (event.issue.pull_request) {
    return {
      skipped: true,
      reason: "Pull requests are not mirrored by this example",
    };
  }

  return mirrorIssue({
    sourceOwner,
    sourceRepo: event.repository.name,
    issueNumber: event.issue.number,
    targetOwner: event.targetOwner,
    targetRepo: event.targetRepo,
  });
}

export async function mirrorIssue(params: MirrorIssueParams): Promise<MirrorIssueResult> {
  const sourceAuth = await getUrlCredentialClient(githubCredential);
  const targetAuth = await getUrlCredentialClient(githubCredential);

  const sourceIssue = await getIssue(
    sourceAuth,
    params.sourceOwner,
    params.sourceRepo,
    params.issueNumber,
  );

  if (sourceIssue.pull_request) {
    throw new Error("This example mirrors issues only, not pull requests");
  }

  const existingTargetIssue = await findMirroredIssue(
    targetAuth,
    params.targetOwner,
    params.targetRepo,
    buildMirrorMarker(params.sourceOwner, params.sourceRepo, params.issueNumber),
  );

  const payload = buildTargetIssuePayload(
    params.sourceOwner,
    params.sourceRepo,
    sourceIssue,
  );

  if (existingTargetIssue) {
    const updatedIssue = await updateIssue(
      targetAuth,
      params.targetOwner,
      params.targetRepo,
      existingTargetIssue.number,
      payload,
    );

    return {
      source: {
        owner: params.sourceOwner,
        repo: params.sourceRepo,
        issueNumber: params.issueNumber,
      },
      target: {
        owner: params.targetOwner,
        repo: params.targetRepo,
        issueNumber: updatedIssue.number,
        created: false,
        url: updatedIssue.html_url,
      },
    };
  }

  const createdIssue = await createIssue(
    targetAuth,
    params.targetOwner,
    params.targetRepo,
    payload,
  );

  return {
    source: {
      owner: params.sourceOwner,
      repo: params.sourceRepo,
      issueNumber: params.issueNumber,
    },
    target: {
      owner: params.targetOwner,
      repo: params.targetRepo,
      issueNumber: createdIssue.number,
      created: true,
      url: createdIssue.html_url,
    },
  };
}

function shouldMirrorAction(action: string): boolean {
  return action === "opened"
    || action === "edited"
    || action === "reopened"
    || action === "closed";
}

function getRepositoryOwner(repository: GitHubRepository): string | null {
  return repository.owner.login ?? repository.owner.name ?? null;
}

function buildTargetIssuePayload(
  sourceOwner: string,
  sourceRepo: string,
  sourceIssue: GitHubIssue,
): CreateOrUpdateIssuePayload {
  return {
    title: `[${sourceOwner}/${sourceRepo}#${sourceIssue.number}] ${sourceIssue.title}`,
    body: [
      buildMirrorMarker(sourceOwner, sourceRepo, sourceIssue.number),
      `Mirrored from ${sourceOwner}/${sourceRepo}#${sourceIssue.number}`,
      "",
      `Source URL: ${sourceIssue.html_url}`,
      `Original author: @${sourceIssue.user.login}`,
      "",
      sourceIssue.body?.trim() || "_No body provided on the source issue._",
    ].join("\n"),
    state: sourceIssue.state,
  };
}

function buildMirrorMarker(sourceOwner: string, sourceRepo: string, issueNumber: number): string {
  return `<!-- natstack-mirror-source: ${sourceOwner}/${sourceRepo}#${issueNumber} -->`;
}

async function getIssue(
  auth: UrlCredentialClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  return githubRequest<GitHubIssue>(
    auth,
    buildIssuePath(owner, repo, issueNumber),
    { method: "GET" },
  );
}

async function createIssue(
  auth: UrlCredentialClient,
  owner: string,
  repo: string,
  payload: CreateOrUpdateIssuePayload,
): Promise<GitHubIssue> {
  return githubRequest<GitHubIssue>(
    auth,
    buildIssuesPath(owner, repo),
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

async function updateIssue(
  auth: UrlCredentialClient,
  owner: string,
  repo: string,
  issueNumber: number,
  payload: CreateOrUpdateIssuePayload,
): Promise<GitHubIssue> {
  return githubRequest<GitHubIssue>(
    auth,
    buildIssuePath(owner, repo, issueNumber),
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

async function findMirroredIssue(
  auth: UrlCredentialClient,
  owner: string,
  repo: string,
  marker: string,
): Promise<MirrorLookupIssue | null> {
  for (let page = 1; page <= 10; page += 1) {
    const path = `${buildIssuesPath(owner, repo)}?state=all&per_page=100&page=${page}`;
    const issues = await githubRequest<MirrorLookupIssue[]>(auth, path, { method: "GET" });

    const match = issues.find((issue) => !issue.pull_request && issue.body?.includes(marker));
    if (match) {
      return match;
    }

    if (issues.length < 100) {
      return null;
    }
  }

  throw new Error("Mirror lookup exceeded 10 pages of issues; narrow the target repository or add persistent mapping");
}

async function githubRequest<T>(
  auth: UrlCredentialClient,
  path: string,
  init: RequestInit,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");

  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await auth.fetch(`${GITHUB_API_FALLBACK}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}) for ${path}: ${body}`,
    );
  }

  return await response.json() as T;
}

function buildIssuesPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

function buildIssuePath(owner: string, repo: string, issueNumber: number): string {
  return `${buildIssuesPath(owner, repo)}/${issueNumber}`;
}
