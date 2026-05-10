/**
 * Sensitive action queue for shell-owned prompts.
 *
 * Despite the historical ApprovalQueue name, this queue handles more than
 * access approvals: one-shot actions, reusable permission grants, and
 * privileged setup prompts all share this user-decision rendezvous point.
 */

import { randomUUID } from "node:crypto";

import { canonicalKey } from "@natstack/shared/canonicalKey";
import type { EventService } from "@natstack/shared/eventsService";
import type {
  ApprovalDecision,
  ApprovalPrincipal,
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingClientConfigApproval,
  PendingUserlandApproval,
  UserlandApprovalChoice,
  UserlandApprovalOption,
  UserlandApprovalSubject,
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
  credentialUse?: PendingCredentialApproval["credentialUse"];
  gitOperation?: PendingCredentialApproval["gitOperation"];
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthUserinfoOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
  replacementCredentialLabel?: string;
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

export interface ClientConfigApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "client-config";
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  title: string;
  description?: string;
  fields: PendingClientConfigApproval["fields"];
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

export interface UserlandApprovalQueueRequest {
  principal: ApprovalPrincipal;
  subject: UserlandApprovalSubject;
  title: string;
  summary?: string;
  warning?: string;
  details?: PendingUserlandApproval["details"];
  options: UserlandApprovalOption[];
  signal?: AbortSignal;
}

export type ApprovalQueueRequest =
  | CredentialApprovalQueueRequest
  | CapabilityApprovalQueueRequest
  | ClientConfigApprovalQueueRequest
  | CredentialInputApprovalQueueRequest;
export type DecisionApprovalQueueRequest = CredentialApprovalQueueRequest | CapabilityApprovalQueueRequest;

export type ClientConfigApprovalResult =
  | { decision: "submit"; values: Record<string, string> }
  | { decision: "deny" };
export type FieldInputApprovalResult = ClientConfigApprovalResult;
export type UserlandApprovalResult = UserlandApprovalChoice;

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

interface UserlandQueueWaiter {
  resolve: (result: UserlandApprovalResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueueEntry {
  approval: PendingApproval;
  dedupKey: string;
  waiters: Map<number, QueueWaiter>;
  fieldInputWaiters: Map<number, FieldInputQueueWaiter>;
  userlandWaiters: Map<number, UserlandQueueWaiter>;
  nextWaiterId: number;
}

export interface ApprovalQueue {
  request(req: DecisionApprovalQueueRequest): Promise<GrantedDecision>;
  requestClientConfig(req: ClientConfigApprovalQueueRequest): Promise<ClientConfigApprovalResult>;
  requestCredentialInput(req: CredentialInputApprovalQueueRequest): Promise<FieldInputApprovalResult>;
  requestUserland(req: UserlandApprovalQueueRequest): Promise<UserlandApprovalResult>;
  onPendingChanged?(listener: (pending: PendingApproval[]) => void): () => void;
  resolve(approvalId: string, decision: ApprovalDecision): void;
  resolveUserland(approvalId: string, choice: string): void;
  submitClientConfig(approvalId: string, values: Record<string, string>): void;
  submitCredentialInput(approvalId: string, values: Record<string, string>): void;
  listPending(): PendingApproval[];
}

export interface ApprovalQueueWithListeners extends ApprovalQueue {
  onPendingChanged(listener: (pending: PendingApproval[]) => void): () => void;
}

export type SensitiveActionQueue = ApprovalQueue;

export function createApprovalQueue(deps: { eventService: EventService }): ApprovalQueueWithListeners {
  const { eventService } = deps;
  const entriesById = new Map<string, QueueEntry>();
  const entriesByDedupKey = new Map<string, QueueEntry>();
  const pendingListeners = new Set<(pending: PendingApproval[]) => void>();

  function emitPendingChanged(): void {
    const pending = Array.from(entriesById.values()).map((e) => e.approval);
    for (const listener of pendingListeners) {
      try {
        listener(pending);
      } catch (error) {
        console.warn("[ApprovalQueue] pending listener failed:", error);
      }
    }
    eventService.emit("shell-approval:pending-changed", { pending });
  }

  function removeEntry(entry: QueueEntry): void {
    entriesById.delete(entry.approval.approvalId);
    entriesByDedupKey.delete(entry.dedupKey);
  }

  function dedupKeyFor(req: ApprovalQueueRequest): string {
    // TODO(canonicalKey): migrate these legacy approval keys to shared canonicalKey.
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
    if (req.kind === "client-config") {
      return [
        "client-config",
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

  function userlandDedupKeyFor(req: UserlandApprovalQueueRequest): string {
    return canonicalKey(["userland", req.principal.callerId, req.subject.id]);
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
    if (req.kind === "client-config") {
      return {
        ...base,
        kind: "client-config",
        configId: req.configId,
        authorizeUrl: req.authorizeUrl,
        tokenUrl: req.tokenUrl,
        title: req.title,
        description: req.description,
        fields: req.fields,
      } satisfies PendingClientConfigApproval;
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
      credentialUse: req.credentialUse,
      gitOperation: req.gitOperation,
      oauthAuthorizeOrigin: req.oauthAuthorizeOrigin,
      oauthTokenOrigin: req.oauthTokenOrigin,
      oauthUserinfoOrigin: req.oauthUserinfoOrigin,
      oauthAudienceDomainMismatch: req.oauthAudienceDomainMismatch,
      replacementCredentialLabel: req.replacementCredentialLabel,
    } satisfies PendingCredentialApproval;
  }

  function enqueueFieldInputRequest(
    req: ClientConfigApprovalQueueRequest | CredentialInputApprovalQueueRequest,
    expectedKind: "client-config" | "credential-input",
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
        userlandWaiters: new Map(),
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
          if (e.waiters.size === 0 && e.fieldInputWaiters.size === 0 && e.userlandWaiters.size === 0) {
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

  function submitFieldInput(approvalId: string, expectedKind: "client-config" | "credential-input", values: Record<string, string>): void {
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
    for (const waiter of entry.userlandWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ kind: "dismissed" });
    }
    entry.userlandWaiters.clear();

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
          userlandWaiters: new Map(),
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
            if (e.waiters.size === 0 && e.fieldInputWaiters.size === 0 && e.userlandWaiters.size === 0) {
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

    requestClientConfig(req) {
      return enqueueFieldInputRequest(
        req,
        "client-config",
        "Approval dedup collision for client config request",
      );
    },

    requestCredentialInput(req) {
      return enqueueFieldInputRequest(
        req,
        "credential-input",
        "Approval dedup collision for credential input request",
      );
    },

    requestUserland(req) {
      const dedupKey = userlandDedupKeyFor(req);
      let entry = entriesByDedupKey.get(dedupKey);
      let newEntry = false;
      if (!entry) {
        const approval = {
          approvalId: randomUUID(),
          callerId: req.principal.callerId,
          callerKind: req.principal.callerKind,
          repoPath: req.principal.repoPath,
          effectiveVersion: req.principal.effectiveVersion,
          requestedAt: Date.now(),
          kind: "userland",
          subject: req.subject,
          title: req.title,
          summary: req.summary,
          warning: req.warning,
          details: req.details,
          options: req.options,
        } satisfies PendingUserlandApproval;
        entry = {
          approval,
          dedupKey,
          waiters: new Map(),
          fieldInputWaiters: new Map(),
          userlandWaiters: new Map(),
          nextWaiterId: 0,
        };
        entriesById.set(approval.approvalId, entry);
        entriesByDedupKey.set(dedupKey, entry);
        newEntry = true;
      }

      if (entry.approval.kind !== "userland") {
        throw new Error("Approval dedup collision for userland request");
      }

      const bound = entry;
      return new Promise<UserlandApprovalResult>((resolve) => {
        const waiterId = bound.nextWaiterId++;
        const waiter: UserlandQueueWaiter = { resolve, signal: req.signal };

        if (req.signal) {
          const onAbort = () => {
            const e = entriesById.get(bound.approval.approvalId);
            if (!e) {
              resolve({ kind: "dismissed" });
              return;
            }
            e.userlandWaiters.delete(waiterId);
            if (e.waiters.size === 0 && e.fieldInputWaiters.size === 0 && e.userlandWaiters.size === 0) {
              removeEntry(e);
              emitPendingChanged();
            }
            resolve({ kind: "dismissed" });
          };
          waiter.onAbort = onAbort;
          if (req.signal.aborted) {
            queueMicrotask(onAbort);
          } else {
            req.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        bound.userlandWaiters.set(waiterId, waiter);

        if (newEntry) {
          emitPendingChanged();
        }
      });
    },

    onPendingChanged(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
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
      for (const waiter of entry.userlandWaiters.values()) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve({ kind: "dismissed" });
      }
      entry.userlandWaiters.clear();

      emitPendingChanged();
    },

    resolveUserland(approvalId, choice) {
      const entry = entriesById.get(approvalId);
      if (!entry || entry.approval.kind !== "userland") return;

      if (!entry.approval.options.some((option) => option.value === choice)) {
        throw new Error(`Unknown userland approval choice: ${choice}`);
      }

      removeEntry(entry);

      for (const waiter of entry.userlandWaiters.values()) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve({ kind: "choice", choice });
      }
      entry.userlandWaiters.clear();
      for (const waiter of entry.waiters.values()) {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve("deny");
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

    submitClientConfig(approvalId, values) {
      submitFieldInput(approvalId, "client-config", values);
    },

    submitCredentialInput(approvalId, values) {
      submitFieldInput(approvalId, "credential-input", values);
    },

    listPending() {
      return Array.from(entriesById.values()).map((e) => e.approval);
    },
  };
}
