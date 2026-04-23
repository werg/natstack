import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Credential, FlowConfig } from "../types.js";

type BotTokenFlowConfig = FlowConfig & {
  connectionLabel?: string;
  providerId?: string;
  scopes?: string[];
};

function promptForToken(): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    readline.question("Paste your bot token:", (answer) => {
      readline.close();
      resolve(answer.trim());
    });
  });
}

export async function botToken(config: FlowConfig): Promise<Credential | null> {
  const accessToken = await promptForToken();
  const botTokenConfig = config as BotTokenFlowConfig;
  const providerId = botTokenConfig.providerId ?? config.type;

  if (config.probeUrl) {
    const response = await fetch(config.probeUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }
  }

  return {
    providerId,
    connectionId: randomUUID(),
    connectionLabel: botTokenConfig.connectionLabel ?? providerId,
    accountIdentity: {
      providerUserId: "bot",
    },
    accessToken,
    scopes: botTokenConfig.scopes ?? [],
  };
}
