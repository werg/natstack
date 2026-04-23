import type { ProviderManifest } from "../types.js";

export const notion: ProviderManifest = {
  id: "notion",
  displayName: "Notion",
  apiBase: [
    "https://api.notion.com",
  ],
  flows: [
    {
      type: "mcp-dcr",
      resource: "https://mcp.notion.com",
    },
    {
      type: "pat",
      probeUrl: "https://api.notion.com/v1/users/me",
    },
  ],
  scopes: {
    read_content: "read_content",
    insert_content: "insert_content",
    update_content: "update_content",
    read_user: "read_user",
  },
  scopeDescriptions: {
    read_content: "Read pages and databases",
    insert_content: "Create new pages and database entries",
    update_content: "Edit existing pages and database entries",
    read_user: "Read workspace user information",
  },
  whoami: {
    url: "https://api.notion.com/v1/users/me",
    identityPath: {
      username: "name",
      email: "person.email",
      providerUserId: "id",
    },
  },
  rateLimits: {
    requestsPerSecond: 3,
    burstSize: 10,
    strategy: "delay",
  },
  refreshBufferSeconds: 60,
};
