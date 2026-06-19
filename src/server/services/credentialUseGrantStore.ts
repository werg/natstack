import fs from "node:fs";
import path from "node:path";
import type { CredentialUseGrant } from "../../../packages/shared/src/credentials/types.js";
import { writeJsonFileAtomic } from "./atomicFile.js";

interface StoredCredentialUseGrant extends CredentialUseGrant {
  credentialId: string;
}

export interface CredentialUseGrantStoreLike {
  list(credentialId: string): CredentialUseGrant[];
  upsert(credentialId: string, grant: CredentialUseGrant): void | Promise<void>;
}

export class CredentialUseGrantStore implements CredentialUseGrantStoreLike {
  private readonly filePath: string;
  private loaded = false;
  private grants: StoredCredentialUseGrant[] = [];

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "credential-use-grants.json");
  }

  list(credentialId: string): CredentialUseGrant[] {
    this.load();
    return this.grants
      .filter((grant) => grant.credentialId === credentialId)
      .map(({ credentialId: _credentialId, ...grant }) => ({ ...grant }));
  }

  upsert(credentialId: string, grant: CredentialUseGrant): void {
    this.load();
    const key = storedCredentialUseGrantKey({ credentialId, ...grant });
    this.grants = [
      ...this.grants.filter((entry) => storedCredentialUseGrantKey(entry) !== key),
      { credentialId, ...grant },
    ];
    this.save();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const records = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { grants?: unknown }).grants)
          ? (parsed as { grants: unknown[] }).grants
          : [];
      this.grants = records.filter(isStoredCredentialUseGrant);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.grants = [];
        return;
      }
      console.warn(
        `[CredentialUseGrantStore] Ignoring unreadable grant store ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.grants = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(this.filePath, { grants: this.grants });
  }
}

function isStoredCredentialUseGrant(value: unknown): value is StoredCredentialUseGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<StoredCredentialUseGrant>;
  return (
    typeof grant.credentialId === "string" &&
    typeof grant.bindingId === "string" &&
    typeof grant.use === "string" &&
    typeof grant.resource === "string" &&
    typeof grant.action === "string" &&
    typeof grant.scope === "string" &&
    typeof grant.grantedAt === "number" &&
    typeof grant.grantedBy === "string"
  );
}

function storedCredentialUseGrantKey(grant: StoredCredentialUseGrant): string {
  return [
    grant.credentialId,
    grant.bindingId,
    grant.use,
    grant.resource,
    grant.action,
    grant.scope,
    grant.callerId ?? "",
    grant.repoPath ?? "",
    grant.effectiveVersion ?? "",
  ].join("\x00");
}
