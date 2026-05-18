import * as fs from "node:fs";
import * as path from "node:path";

import { canonicalKey } from "@natstack/shared/canonicalKey";
import { writeJsonFileAtomic } from "./atomicFile.js";
import type {
  UserlandApprovalGrant,
  UserlandApprovalIssuer,
  UserlandApprovalSubject,
} from "@natstack/shared/approvals";

interface UserlandApprovalGrantFile {
  grants: UserlandApprovalGrant[];
}

function defaultIssuer(principal: UserlandApprovalGrant["principal"]): UserlandApprovalIssuer {
  return { kind: principal.callerKind, id: principal.callerId };
}

function effectiveIssuer(grant: UserlandApprovalGrant): UserlandApprovalIssuer {
  return grant.issuer ?? defaultIssuer(grant.principal);
}

export class UserlandApprovalGrantStore {
  private readonly filePath: string;
  private persistent: UserlandApprovalGrantFile = { grants: [] };

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "userland-approval-grants.json");
    this.load();
  }

  /**
   * Look up a grant for a (principal, issuer, subject) triple. When `issuer`
   * is omitted, defaults to the principal — this preserves the direct
   * panel/worker call shape, where the issuer is the principal itself.
   */
  lookup(
    callerId: string,
    subjectId: string,
    issuer?: UserlandApprovalIssuer
  ): UserlandApprovalGrant | null {
    return (
      this.persistent.grants.find((grant) => {
        if (grant.principal.callerId !== callerId) return false;
        if (grant.subject.id !== subjectId) return false;
        const grantIssuer = effectiveIssuer(grant);
        if (issuer) return grantIssuer.kind === issuer.kind && grantIssuer.id === issuer.id;
        return (
          grantIssuer.kind === grant.principal.callerKind &&
          grantIssuer.id === grant.principal.callerId
        );
      }) ?? null
    );
  }

  // `record`/`revoke` are `async` even though `save()` is sync today: the
  // service awaits them, and keeping the API async lets us swap in
  // temp-file+rename later without touching callers.
  async record(
    principal: UserlandApprovalGrant["principal"],
    subject: UserlandApprovalSubject,
    choice: string,
    now = Date.now(),
    issuer?: UserlandApprovalIssuer
  ): Promise<void> {
    const next: UserlandApprovalGrant = {
      principal: {
        callerId: principal.callerId,
        callerKind: principal.callerKind,
      },
      ...(issuer ? { issuer } : {}),
      subject,
      choice,
      grantedAt: now,
    };
    const nextIssuer = effectiveIssuer(next);
    const key = keyFor(next.principal.callerId, nextIssuer, next.subject.id);
    this.persistent.grants = [
      ...this.persistent.grants.filter(
        (grant) =>
          keyFor(grant.principal.callerId, effectiveIssuer(grant), grant.subject.id) !== key
      ),
      next,
    ];
    this.save();
  }

  async revoke(
    callerId: string,
    subjectId: string,
    issuer?: UserlandApprovalIssuer
  ): Promise<boolean> {
    const before = this.persistent.grants.length;
    this.persistent.grants = this.persistent.grants.filter((grant) => {
      if (grant.principal.callerId !== callerId) return true;
      if (grant.subject.id !== subjectId) return true;
      const grantIssuer = effectiveIssuer(grant);
      if (issuer) return !(grantIssuer.kind === issuer.kind && grantIssuer.id === issuer.id);
      return !(
        grantIssuer.kind === grant.principal.callerKind &&
        grantIssuer.id === grant.principal.callerId
      );
    });
    const removed = this.persistent.grants.length !== before;
    if (removed) this.save();
    return removed;
  }

  list(callerId: string): UserlandApprovalGrant[] {
    return this.persistent.grants.filter((grant) => grant.principal.callerId === callerId);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8")
      ) as UserlandApprovalGrantFile;
      this.persistent = {
        grants: Array.isArray(parsed.grants) ? parsed.grants.filter(isGrant) : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[UserlandApprovalGrantStore] Failed to load grants; starting empty:", err);
      }
      this.persistent = { grants: [] };
    }
  }

  private save(): void {
    writeJsonFileAtomic(this.filePath, this.persistent);
  }
}

export function keyFor(
  callerId: string,
  issuer: UserlandApprovalIssuer,
  subjectId: string
): string {
  return canonicalKey(["userland-grant", callerId, issuer.kind, issuer.id, subjectId]);
}

function isGrant(value: unknown): value is UserlandApprovalGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<UserlandApprovalGrant>;
  if (
    grant.issuer !== undefined &&
    (typeof grant.issuer !== "object" ||
      grant.issuer === null ||
      typeof (grant.issuer as UserlandApprovalIssuer).id !== "string" ||
      !["panel", "worker", "extension"].includes((grant.issuer as UserlandApprovalIssuer).kind))
  ) {
    return false;
  }
  return (
    typeof grant.choice === "string" &&
    typeof grant.grantedAt === "number" &&
    !!grant.principal &&
    typeof grant.principal.callerId === "string" &&
    (grant.principal.callerKind === "panel" || grant.principal.callerKind === "worker") &&
    !!grant.subject &&
    typeof grant.subject.id === "string" &&
    (grant.subject.label === undefined || typeof grant.subject.label === "string")
  );
}
