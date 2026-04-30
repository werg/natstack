/**
 * Sensitive action queue for shell-owned prompts.
 *
 * Despite the historical ApprovalQueue name, this queue handles more than
 * access approvals: one-shot actions, reusable permission grants, and
 * privileged setup prompts all share this user-decision rendezvous point.
 */

import { randomUUID } from "node:crypto";

import type { EventService } from "@natstack/shared/eventsService";
import type {
  ApprovalDecision,
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingOAuthClientConfigApproval,
} from "@natstack/shared/approvals";
import type { AccountIdentity, CredentialInjection, UrlAudience } from "@natstack/shared/credentials/types";

/** Terminal decision surfaced back to queue waiters (dismiss collapses to deny). */
export type GrantedDecision = "once" | "session" | "version" | "repo" | "deny";

interface ApprovalQueueRequestBase {
  callerId: string;
  callerKind: "panel" | "worker";
  repoPath: string;
  effectiveVersion: string;
  signal?: AbortSignal;
}

export interface CredentialApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind?: "credential";
  credentialId: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
}

export interface CapabilityApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "capability";
  capability: string;
  /**
   * Override pending-request deduplication for capability prompts. `null`
   * isolates this request so a one-shot approval cannot release unrelated
   * waiters for the same resource.
   */
  dedupKey?: string | null;
  title: string;
  description?: string;
  resource?: PendingCapabilityApproval["resource"];
  details?: PendingCapabilityApproval["details"];
}

export interface OAuthClientConfigApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "oauth-client-config";
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  title: string;
  description?: string;
  fields: PendingOAuthClientConfigApproval["fields"];
}

export interface CredentialInputApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "credential-input";
  title: string;
  description?: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  fields: PendingCredentialInputApproval["fields"];
}

export type ApprovalQueueRequest =
  | CredentialApprovalQueueRequest
  | CapabilityApprovalQueueRequest
  | OAuthClientConfigApprovalQueueRequest
  | CredentialInputApprovalQueueRequest;
export type DecisionApprovalQueueRequest = CredentialApprovalQueueRequest | CapabilityApprovalQueueRequest;

export type OAuthClientConfigApprovalResult =
  | { decision: "submit"; values: Record<string, string> }
  | { decision: "deny" };
export type FieldInputApprovalResult = OAuthClientConfigApprovalResult;

interface QueueWaiter {
  resolve: (decision: GrantedDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface FieldInputQueueWaiter {
  resolve: (result: FieldInputApprovalResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueueEntry {
  approval: PendingApproval;
  dedupKey: string;
  waiters: Map<number, QueueWaiter>;
  fieldInputWaiters: Map<number, FieldInputQueueWaiter>;
  nextWaiterId: number;
}

export interface ApprovalQueue {
  request(req: DecisionApprovalQueueRequest): Promise<GrantedDecision>;
  requestOAuthClientConfig(req: OAuthClientConfigApprovalQueueRequest): Promise<OAuthClientConfigApprovalResult>;
  requestCredentialInput(req: CredentialInputApprovalQueueRequest): Promise<FieldInputApprovalResult>;
  resolve(approvalId: string, decision: ApprovalDecision): void;
  submitOAuthClientConfig(approvalId: string, values: Record<string, string>): void;
  submitCredentialInput(approvalId: string, values: Record<string, string>): void;
  listPending(): PendingApproval[];
}

export type SensitiveActionQueue = ApprovalQueue;

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
    if (req.kind === "capability") {
      if (req.dedupKey === null) {
        return ["capability-isolated", randomUUID()].join("\x00");
      }
      if (req.dedupKey) {
        return ["capability-custom", req.dedupKey].join("\x00");
      }
      return [
        "capability",
        req.repoPath,
        req.effectiveVersion,
        req.capability,
        req.resource?.value ?? "",
      ].join("\x00");
    }
    if (req.kind === "oauth-client-config") {
      return [
        "oauth-client-config",
        req.repoPath,
        req.effectiveVersion,
        req.configId,
        req.authorizeUrl,
        req.tokenUrl,
        req.fields.map((field) => field.name).join(","),
      ].join("\x00");
    }
    if (req.kind === "credential-input") {
      // A submitted secret is a one-shot input, not a reusable approval. Keep
      // concurrent prompts isolated so one submission cannot release multiple
      // waiters and create duplicate credentials.
      return ["credential-input-isolated", randomUUID()].join("\x00");
    }
    return `${req.repoPath}\x00${req.effectiveVersion}\x00${req.credentialId}`;
  }

  function createPendingApproval(req: ApprovalQueueRequest): PendingApproval {
    const base = {
      approvalId: randomUUID(),
      callerId: req.callerId,
      callerKind: req.callerKind,
      repoPath: req.repoPath,
      effectiveVersion: req.effectiveVersion,
      requestedAt: Date.now(),
    };
    if (req.kind === "capability") {
      return {
        ...base,
        kind: "capability",
        capability: req.capability,
        title: req.title,
        description: req.description,
        resource: req.resource,
        details: req.details,
      } satisfies PendingCapabilityApproval;
    }
    if (req.kind === "oauth-client-config") {
      return {
        ...base,
        kind: "oauth-client-config",
        configId: req.configId,
        authorizeUrl: req.authorizeUrl,
        tokenUrl: req.tokenUrl,
        title: req.title,
        description: req.description,
        fields: req.fields,
      } satisfies PendingOAuthClientConfigApproval;
    }
    if (req.kind === "credential-input") {
      return {
        ...base,
        kind: "credential-input",
        title: req.title,
        description: req.description,
        credentialLabel: req.credentialLabel,
        audience: req.audience,
        injection: req.injection,
        accountIdentity: req.accountIdentity,
        scopes: req.scopes,
        fields: req.fields,
      } satisfies PendingCredentialInputApproval;
    }
    return {
      ...base,
      kind: "credential",
      credentialId: req.credentialId,
      credentialLabel: req.credentialLabel,
      audience: req.audience,
      injection: req.injection,
      accountIdentity: req.accountIdentity,
      scopes: req.scopes,
      oauthAuthorizeOrigin: req.oauthAuthorizeOrigin,
      oauthTokenOrigin: req.oauthTokenOrigin,
      oauthAudienceDomainMismatch: req.oauthAudienceDomainMismatch,
    } satisfies PendingCredentialApproval;
  }

  function enqueueFieldInputRequest(
    req: OAuthClientConfigApprovalQueueRequest | CredentialInputApprovalQueueRequest,
    expectedKind: "oauth-client-config" | "credential-input",
    collisionMessage: string,
  ): Promise<FieldInputApprovalResult> {
    const dedupKey = dedupKeyFor(req);
    let entry = entriesByDedupKey.get(dedupKey);
    let newEntry = false;
    if (!entry) {
      const approval = createPendingApproval(req);
      entry = {
        approval,
        dedupKey,
        waiters: new Map(),
        fieldInputWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);
      newEntry = true;
    }

    if (entry.approval.kind !== expectedKind) {
      throw new Error(collisionMessage);
    }

    const bound = entry;
    return new Promise<FieldInputApprovalResult>((resolve) => {
      const waiterId = bound.nextWaiterId++;
      const waiter: FieldInputQueueWaiter = { resolve, signal: req.signal };

      if (req.signal) {
        const onAbort = () => {
          const e = entriesById.get(bound.approval.approvalId);
          if (!e) {
            resolve({ decision: "deny" });
            return;
          }
          e.fieldInputWaiters.delete(waiterId);
          if (e.waiters.size === 0 && e.fieldInputWaiters.size === 0) {
            removeEntry(e);
            emitPendingChanged();
          }
          resolve({ decision: "deny" });
        };
        waiter.onAbort = onAbort;
        if (req.signal.aborted) {
          queueMicrotask(onAbort);
        } else {
          req.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      bound.fieldInputWaiters.set(waiterId, waiter);

      if (newEntry) {
        emitPendingChanged();
      }
    });
  }

  function submitFieldInput(approvalId: string, expectedKind: "oauth-client-config" | "credential-input", values: Record<string, string>): void {
    const entry = entriesById.get(approvalId);
    if (!entry || entry.approval.kind !== expectedKind) return;

    removeEntry(entry);

    for (const waiter of entry.fieldInputWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ decision: "submit", values });
    }
    entry.fieldInputWaiters.clear();
    for (const waiter of entry.waiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve("deny");
    }
    entry.waiters.clear();

    emitPendingChanged();
  }

  return {
    request(req) {
      const dedupKey = dedupKeyFor(req);
      let entry = entriesByDedupKey.get(dedupKey);
      let newEntry = false;
      if (!entry) {
        const approval = createPendingApproval(req);
        entry = {
          approval,
          dedupKey,
          waiters: new Map(),
          fieldInputWaiters: new Map(),
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

    requestOAuthClientConfig(req) {
      return enqueueFieldInputRequest(
        req,
        "oauth-client-config",
        "Approval dedup collision for OAuth client config request",
      );
    },

    requestCredentialInput(req) {
      return enqueueFieldInputRequest(
        req,
        "credential-input",
        "Approval dedup collision for credential input request",
      );
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
      for (const waiter of entry.fieldInputWaiters.values()) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve({ decision: "deny" });
      }
      entry.fieldInputWaiters.clear();

      emitPendingChanged();
    },

    submitOAuthClientConfig(approvalId, values) {
      submitFieldInput(approvalId, "oauth-client-config", values);
    },

    submitCredentialInput(approvalId, values) {
      submitFieldInput(approvalId, "credential-input", values);
    },

    listPending() {
      return Array.from(entriesById.values()).map((e) => e.approval);
    },
  };
}
