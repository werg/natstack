import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Credential, FlowConfig } from "../types.js";

function promptForToken(prompt: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    readline.question(prompt, (answer) => {
      readline.close();
      resolve(answer.trim());
    });
  });
}

export async function pat(config: FlowConfig): Promise<Credential | null> {
  const accessToken = await promptForToken("Paste your personal access token:");

  if (config.probeUrl) {
    try {
      const response = await fetch(config.probeUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        console.error(
          `PAT validation failed for ${config.type}: received status ${response.status}.`,
        );
        return null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`PAT validation failed for ${config.type}: ${message}`);
      return null;
    }
  }

  const providerId = config.type;

  return {
    providerId,
    connectionId: randomUUID(),
    connectionLabel: `${providerId} PAT`,
    accountIdentity: {
      providerUserId: "pat-user",
    },
    accessToken,
    scopes: [],
  };
}
