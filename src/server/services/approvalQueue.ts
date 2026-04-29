/**
 * Approval queue for shell-owned consent prompts.
 *
 * Approval queue for shell-owned credential prompts.
 */

import { randomUUID } from "node:crypto";

import type { EventService } from "@natstack/shared/eventsService";
import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";
import type { AccountIdentity, CredentialInjection, UrlAudience } from "@natstack/shared/credentials/types";

/** Terminal decision surfaced back to queue waiters (dismiss collapses to deny). */
export type GrantedDecision = "session" | "version" | "repo" | "deny";

export interface ApprovalQueueRequest {
  callerId: string;
  callerKind: "panel" | "worker";
  repoPath: string;
  effectiveVersion: string;
  credentialId: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
  signal?: AbortSignal;
}

interface QueueWaiter {
  resolve: (decision: GrantedDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueueEntry {
  approval: PendingApproval;
  dedupKey: string;
  waiters: Map<number, QueueWaiter>;
  nextWaiterId: number;
}

export interface ApprovalQueue {
  request(req: ApprovalQueueRequest): Promise<GrantedDecision>;
  resolve(approvalId: string, decision: ApprovalDecision): void;
  listPending(): PendingApproval[];
}

export function createApprovalQueue(deps: { eventService: EventService }): ApprovalQueue {
  const { eventService } = deps;
  const entriesById = new Map<string, QueueEntry>();
  const entriesByDedupKey = new Map<string, QueueEntry>();

  function emitPendingChanged(): void {
    const pending = Array.from(entriesById.values()).map((e) => e.approval);
    eventService.emit("shell-approval:pending-changed", { pending });
  }

  function removeEntry(entry: QueueEntry): void {
    entriesById.delete(entry.approval.approvalId);
    entriesByDedupKey.delete(entry.dedupKey);
  }

  function dedupKeyFor(req: ApprovalQueueRequest): string {
    return `${req.repoPath}\x00${req.effectiveVersion}\x00${req.credentialId}`;
  }

  return {
    request(req) {
      const dedupKey = dedupKeyFor(req);
      let entry = entriesByDedupKey.get(dedupKey);
      let newEntry = false;
      if (!entry) {
        const approval: PendingApproval = {
          approvalId: randomUUID(),
          callerId: req.callerId,
          callerKind: req.callerKind,
          repoPath: req.repoPath,
          effectiveVersion: req.effectiveVersion,
          credentialId: req.credentialId,
          credentialLabel: req.credentialLabel,
          audience: req.audience,
          injection: req.injection,
          accountIdentity: req.accountIdentity,
          scopes: req.scopes,
          oauthAuthorizeOrigin: req.oauthAuthorizeOrigin,
          oauthTokenOrigin: req.oauthTokenOrigin,
          oauthAudienceDomainMismatch: req.oauthAudienceDomainMismatch,
          requestedAt: Date.now(),
        };
        entry = {
          approval,
          dedupKey,
          waiters: new Map(),
          nextWaiterId: 0,
        };
        entriesById.set(approval.approvalId, entry);
        entriesByDedupKey.set(dedupKey, entry);
        newEntry = true;
      }

      const bound = entry;
      return new Promise<GrantedDecision>((resolve) => {
        const waiterId = bound.nextWaiterId++;
        const waiter: QueueWaiter = { resolve, signal: req.signal };

        if (req.signal) {
          const onAbort = () => {
            const e = entriesById.get(bound.approval.approvalId);
            if (!e) {
              resolve("deny");
              return;
            }
            e.waiters.delete(waiterId);
            if (e.waiters.size === 0) {
              removeEntry(e);
              emitPendingChanged();
            }
            resolve("deny");
          };
          waiter.onAbort = onAbort;
          if (req.signal.aborted) {
            queueMicrotask(onAbort);
          } else {
            req.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        bound.waiters.set(waiterId, waiter);

        if (newEntry) {
          emitPendingChanged();
        }
      });
    },

    resolve(approvalId, decision) {
      const entry = entriesById.get(approvalId);
      if (!entry) return;

      removeEntry(entry);

      const granted: GrantedDecision =
        decision === "dismiss" ? "deny" : decision;

      for (const waiter of entry.waiters.values()) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve(granted);
      }
      entry.waiters.clear();

      emitPendingChanged();
    },

    listPending() {
      return Array.from(entriesById.values()).map((e) => e.approval);
    },
  };
}
