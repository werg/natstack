import { exec } from "node:child_process";
import * as crypto from "node:crypto";

import type { AccountIdentity, Credential, FlowConfig } from "../types.js";

const CLI_TIMEOUT_MS = 10_000;

function getProviderId(config: FlowConfig): string {
  const providerId = (config as FlowConfig & { providerId?: unknown }).providerId;

  return typeof providerId === "string" && providerId.trim().length > 0 ? providerId.trim() : "cli";
}

function normalizeOutput(output: string | Buffer): string {
  return typeof output === "string" ? output : output.toString("utf8");
}

function getValueAtPath(value: unknown, path: string): unknown {
  let current: unknown = value;

  for (const segment of path.split(".").filter((part) => part.length > 0)) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index)) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (current === null || typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function extractToken(stdout: string, jsonPath?: string): string | null {
  if (!jsonPath) {
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }

  const value = getValueAtPath(parsed, jsonPath);

  if (typeof value !== "string") {
    return null;
  }

  const token = value.trim();
  return token.length > 0 ? token : null;
}

function runCommand(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        encoding: "utf8",
        timeout: CLI_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        resolve(normalizeOutput(stdout));
      }
    );
  });
}

export async function cliPiggyback(config: FlowConfig): Promise<Credential | null> {
  const command = config.command?.trim();

  if (!command) {
    return null;
  }

  const stdout = await runCommand(command);

  if (stdout === null) {
    return null;
  }

  const accessToken = extractToken(stdout, config.jsonPath);

  if (!accessToken) {
    return null;
  }

  const providerId = getProviderId(config);
  const accountIdentity: AccountIdentity = {
    providerUserId: "cli-user",
  };

  return {
    providerId,
    connectionId: crypto.randomUUID(),
    connectionLabel: `CLI piggyback via ${providerId}: ${command}`,
    accountIdentity,
    accessToken,
    scopes: [],
  };
}
