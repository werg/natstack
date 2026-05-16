import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonFileAtomic } from "./atomicFile.js";

export type CapabilityGrantDecision = "session" | "version" | "repo";

export interface CapabilityGrantIdentity {
  repoPath: string;
  effectiveVersion: string;
}

export interface CapabilityGrant {
  capability: string;
  resourceKey: string;
  scope: CapabilityGrantDecision;
  repoPath: string;
  effectiveVersion?: string;
  credentialSelectionId?: string | null;
  grantedAt: number;
}

interface CapabilityGrantFile {
  grants: CapabilityGrant[];
}

export class CapabilityGrantStore {
  private readonly sessionGrants = new Map<string, CapabilityGrant>();
  private readonly filePath: string;
  private persistent: CapabilityGrantFile = { grants: [] };

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "capability-grants.json");
    this.load();
  }

  hasGrant(capability: string, resourceKey: string, identity: CapabilityGrantIdentity): boolean {
    return !!this.getGrant(capability, resourceKey, identity);
  }

  getGrant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity
  ): CapabilityGrant | null {
    const sessionGrant = this.sessionGrants.get(grantKey("session", capability, resourceKey, identity));
    if (sessionGrant) {
      return sessionGrant;
    }
    return (
      this.persistent.grants.find(
        (grant) =>
          grant.capability === capability &&
          grant.resourceKey === resourceKey &&
          ((grant.scope === "repo" && grant.repoPath === identity.repoPath) ||
            (grant.scope === "version" &&
              grant.repoPath === identity.repoPath &&
              grant.effectiveVersion === identity.effectiveVersion))
      ) ?? null
    );
  }

  grant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    scope: CapabilityGrantDecision,
    options: { credentialSelectionId?: string | null } = {},
    now = Date.now()
  ): void {
    const next: CapabilityGrant = {
      capability,
      resourceKey,
      scope,
      repoPath: identity.repoPath,
      effectiveVersion: scope === "repo" ? undefined : identity.effectiveVersion,
      credentialSelectionId: options.credentialSelectionId,
      grantedAt: now,
    };
    if (scope === "session") {
      this.sessionGrants.set(grantKey(scope, capability, resourceKey, identity), next);
      return;
    }
    this.persistent.grants = [
      ...this.persistent.grants.filter(
        (grant) =>
          !(
            grant.capability === next.capability &&
            grant.resourceKey === next.resourceKey &&
            grant.scope === next.scope &&
            grant.repoPath === next.repoPath &&
            grant.effectiveVersion === next.effectiveVersion
          )
      ),
      next,
    ];
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as CapabilityGrantFile;
      this.persistent = {
        grants: Array.isArray(parsed.grants)
          ? parsed.grants.filter((grant) => grant.capability !== "cors")
          : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  private save(): void {
    writeJsonFileAtomic(this.filePath, this.persistent);
  }
}

function grantKey(
  scope: CapabilityGrantDecision,
  capability: string,
  resourceKey: string,
  identity: CapabilityGrantIdentity
): string {
  // TODO(canonicalKey): migrate this legacy grant key to shared canonicalKey.
  return [
    scope,
    capability,
    resourceKey,
    identity.repoPath,
    scope === "version" || scope === "session" ? identity.effectiveVersion : "",
  ].join("\x00");
}
