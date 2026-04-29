import * as fs from "node:fs";
import * as path from "node:path";

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
  grantedAt: number;
}

interface CapabilityGrantFile {
  grants: CapabilityGrant[];
}

export class CapabilityGrantStore {
  private readonly sessionGrants = new Set<string>();
  private readonly filePath: string;
  private persistent: CapabilityGrantFile = { grants: [] };

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "capability-grants.json");
    this.load();
  }

  hasGrant(capability: string, resourceKey: string, identity: CapabilityGrantIdentity): boolean {
    if (this.sessionGrants.has(grantKey("session", capability, resourceKey, identity))) {
      return true;
    }
    return this.persistent.grants.some((grant) =>
      grant.capability === capability
      && grant.resourceKey === resourceKey
      && (
        (grant.scope === "repo" && grant.repoPath === identity.repoPath)
        || (
          grant.scope === "version"
          && grant.repoPath === identity.repoPath
          && grant.effectiveVersion === identity.effectiveVersion
        )
      ),
    );
  }

  grant(
    capability: string,
    resourceKey: string,
    identity: CapabilityGrantIdentity,
    scope: CapabilityGrantDecision,
    now = Date.now(),
  ): void {
    if (scope === "session") {
      this.sessionGrants.add(grantKey(scope, capability, resourceKey, identity));
      return;
    }
    const next: CapabilityGrant = {
      capability,
      resourceKey,
      scope,
      repoPath: identity.repoPath,
      effectiveVersion: scope === "version" ? identity.effectiveVersion : undefined,
      grantedAt: now,
    };
    this.persistent.grants = [
      ...this.persistent.grants.filter((grant) =>
        !(
          grant.capability === next.capability
          && grant.resourceKey === next.resourceKey
          && grant.scope === next.scope
          && grant.repoPath === next.repoPath
          && grant.effectiveVersion === next.effectiveVersion
        ),
      ),
      next,
    ];
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as CapabilityGrantFile;
      this.persistent = {
        grants: Array.isArray(parsed.grants) ? parsed.grants : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.persistent, null, 2), "utf8");
  }
}

function grantKey(
  scope: CapabilityGrantDecision,
  capability: string,
  resourceKey: string,
  identity: CapabilityGrantIdentity,
): string {
  return [
    scope,
    capability,
    resourceKey,
    identity.repoPath,
    scope === "version" || scope === "session" ? identity.effectiveVersion : "",
  ].join("\x00");
}
