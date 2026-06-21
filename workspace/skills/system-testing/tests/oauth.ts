import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasMarkerCount,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const oauthTests: TestCase[] = [
  {
    name: "list-providers",
    description: "List configured OAuth providers",
    category: "oauth",
    prompt: "Exercise OAuth provider inspection. Finish with OAUTH_PROVIDERS_OK and count.",
    validate: (result) => {
      const msg = finalMessageHasMarkerCount(result, "OAUTH_PROVIDERS_OK");
      if (!msg.passed) return msg;
      return noIncompleteInvocations(result);
    },
  },
  {
    name: "list-connections",
    description: "Check for active OAuth connections",
    category: "oauth",
    prompt: "Exercise OAuth connection inspection. Finish with OAUTH_CONNECTIONS_OK and no-secrets.",
    validate: (result) => checked(result, ["OAUTH_CONNECTIONS_OK", "no-secrets"]),
  },
  {
    name: "get-token-error",
    description: "Get an error when requesting a token without a connection",
    category: "oauth",
    prompt: "Exercise the missing-token path. Finish with OAUTH_TOKEN_ERROR_OK and actionable-error.",
    validate: (result) => checked(result, ["OAUTH_TOKEN_ERROR_OK", "actionable-error"]),
  },
];
