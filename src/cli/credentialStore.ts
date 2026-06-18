import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CliCredentials {
  schemaVersion: 1;
  kind: "device";
  url: string;
  hubUrl?: string;
  workspaceName?: string;
  deviceId: string;
  refreshToken: string;
}

export function credentialPath(): string {
  return path.join(os.homedir(), ".config", "natstack", "cli-credentials.json");
}

export function loadCliCredentials(): CliCredentials | null {
  const p = credentialPath();
  if (!fs.existsSync(p)) return null;
  let parsed: Partial<CliCredentials>;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<CliCredentials>;
  } catch {
    return null;
  }
  if (
    parsed.schemaVersion !== 1 ||
    parsed.kind !== "device" ||
    typeof parsed.url !== "string" ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.refreshToken !== "string"
  ) {
    return null;
  }
  return parsed as CliCredentials;
}

export function saveCliCredentials(creds: CliCredentials): void {
  const p = credentialPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export function clearCliCredentials(): void {
  const p = credentialPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
