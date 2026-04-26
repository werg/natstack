export const manifest = {
  id: "linear",
  displayName: "Linear",
  apiBase: ["https://api.linear.app"],
  flows: [
    {
      type: "loopback-pkce" as const,
      clientId: "YOUR_LINEAR_CLIENT_ID",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
    },
    {
      type: "pat" as const,
      probeUrl: "https://api.linear.app/graphql",
    },
  ],
  scopes: {
    read: "Read issues, projects, and teams",
    write: "Create and update issues",
    "issues:create": "Create new issues",
    "comments:create": "Add comments to issues",
  },
  whoami: {
    url: "https://api.linear.app/graphql",
    identityPath: {
      providerUserId: "data.viewer.id",
      email: "data.viewer.email",
      username: "data.viewer.name",
    },
  },
} as const;

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: { id: string; name: string };
  assignee?: { id: string; name: string; email: string };
  priority: number;
  url: string;
  [key: string]: unknown;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
  [key: string]: unknown;
}

export interface LinearUser {
  id: string;
  name: string;
  email: string;
  [key: string]: unknown;
}

export const integrationManifest = {
  providers: [manifest],
  scopes: {
    linear: ["read", "write"],
  },
  endpoints: {
    linear: [{ url: "https://api.linear.app/graphql", methods: ["POST"] }],
  },
  webhooks: {
    linear: [{ event: "Issue", deliver: "onIssueEvent" }],
  },
} as const;

type GraphQLResponse<T> = {
  data: T;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function linearGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Linear GraphQL request failed with status ${response.status}: ${bodyText}`,
    );
  }

  const payload = (await response.json()) as GraphQLResponse<T>;
  return payload.data;
}

export async function listIssues(teamKey: string): Promise<LinearIssue[]> {
  const data = await linearGraphQL<{
    team: { issues: { nodes: LinearIssue[] } } | null;
  }>(
    `
      query ListIssues($teamKey: String!) {
        team(key: $teamKey) {
          issues {
            nodes {
              id
              identifier
              title
              description
              state {
                id
                name
              }
              assignee {
                id
                name
                email
              }
              priority
              url
            }
          }
        }
      }
    `,
    { teamKey },
  );

  return data.team?.issues.nodes ?? [];
}

export async function createIssue(
  teamId: string,
  title: string,
  description?: string,
): Promise<LinearIssue> {
  const data = await linearGraphQL<{
    issueCreate: { success: boolean; issue: LinearIssue | null };
  }>(
    `
      mutation CreateIssue(
        $teamId: String!
        $title: String!
        $description: String
      ) {
        issueCreate(
          input: { teamId: $teamId, title: $title, description: $description }
        ) {
          success
          issue {
            id
            identifier
            title
            description
            state {
              id
              name
            }
            assignee {
              id
              name
              email
            }
            priority
            url
          }
        }
      }
    `,
    { teamId, title, description },
  );

  if (!data.issueCreate.issue) {
    throw new Error("Linear issueCreate mutation did not return an issue");
  }

  return data.issueCreate.issue;
}

export async function getViewer(): Promise<LinearUser> {
  const data = await linearGraphQL<{ viewer: LinearUser }>(`
    query GetViewer {
      viewer {
        id
        name
        email
      }
    }
  `);

  return data.viewer;
}

export function onIssueEvent(event: unknown): {
  type: "Issue";
  action: string | null;
  issue: unknown;
  raw: unknown;
} {
  const payload = isRecord(event) ? event : null;
  const actionValue = payload?.["action"];
  const action = typeof actionValue === "string" ? actionValue : null;
  const issue = payload && "issue" in payload ? payload["issue"] : null;

  return {
    type: "Issue",
    action,
    issue,
    raw: event,
  };
}

export const linear = {
  manifest,
  integrationManifest,
  listIssues,
  createIssue,
  getViewer,
  onIssueEvent,
} as const;

export default linear;
