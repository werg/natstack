import * as fs from "node:fs";
import * as path from "node:path";

import { canonicalKey } from "@natstack/shared/canonicalKey";
import { writeJsonFileAtomic } from "./atomicFile.js";
import type { UserlandApprovalGrant, UserlandApprovalSubject } from "@natstack/shared/approvals";

interface UserlandApprovalGrantFile {
  grants: UserlandApprovalGrant[];
}

export class UserlandApprovalGrantStore {
  private readonly filePath: string;
  private persistent: UserlandApprovalGrantFile = { grants: [] };

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "userland-approval-grants.json");
    this.load();
  }

  lookup(callerId: string, subjectId: string): UserlandApprovalGrant | null {
    return (
      this.persistent.grants.find(
        (grant) => grant.principal.callerId === callerId && grant.subject.id === subjectId
      ) ?? null
    );
  }

  // `record`/`revoke` are `async` even though `save()` is sync today: the
  // service awaits them, and keeping the API async lets us swap in
  // temp-file+rename later without touching callers.
  async record(
    principal: UserlandApprovalGrant["principal"],
    subject: UserlandApprovalSubject,
    choice: string,
    now = Date.now()
  ): Promise<void> {
    const next: UserlandApprovalGrant = {
      principal: {
        callerId: principal.callerId,
        callerKind: principal.callerKind,
      },
      subject,
      choice,
      grantedAt: now,
    };
    const key = keyFor(next.principal.callerId, next.subject.id);
    this.persistent.grants = [
      ...this.persistent.grants.filter(
        (grant) => keyFor(grant.principal.callerId, grant.subject.id) !== key
      ),
      next,
    ];
    this.save();
  }

  async revoke(callerId: string, subjectId: string): Promise<boolean> {
    const key = keyFor(callerId, subjectId);
    const before = this.persistent.grants.length;
    this.persistent.grants = this.persistent.grants.filter(
      (grant) => keyFor(grant.principal.callerId, grant.subject.id) !== key
    );
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

export function keyFor(callerId: string, subjectId: string): string {
  return canonicalKey(["userland-grant", callerId, subjectId]);
}

function isGrant(value: unknown): value is UserlandApprovalGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Partial<UserlandApprovalGrant>;
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
