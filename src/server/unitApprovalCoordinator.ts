import type { UnitApprovalCoordinator } from "@natstack/unit-host";
import type { PendingUnitBatchApproval, UnitBatchEntry } from "@natstack/shared/approvals";
import type { GrantedDecision } from "./services/approvalQueue.js";

export interface UnitApprovalQueueLike {
  request(req: {
    kind: "unit-batch";
    callerId: string;
    callerKind: "system";
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    trigger: PendingUnitBatchApproval["trigger"];
    title: string;
    description: string;
    units: PendingUnitBatchApproval["units"];
    configWrite?: PendingUnitBatchApproval["configWrite"];
  }): Promise<"once" | "session" | "version" | "repo" | "deny">;
}

export interface StartupUnitApprovalPrompt {
  request(req: {
    title: string;
    description: string;
    units: PendingUnitBatchApproval["units"];
  }): Promise<GrantedDecision>;
}

interface PendingRequest {
  entries: UnitBatchEntry[];
  applyApproved(): Promise<void>;
  applyDenied(): void;
  resolve(): void;
  reject(error: unknown): void;
}

interface PendingBatch {
  trigger: "startup" | "meta-push";
  requests: PendingRequest[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class ServerUnitApprovalCoordinator implements UnitApprovalCoordinator<UnitBatchEntry> {
  private pending = new Map<"startup" | "meta-push", PendingBatch>();

  constructor(
    private readonly deps: {
      approvalQueue: UnitApprovalQueueLike;
      delayMs?: number;
      autoApproveStartup?: boolean;
      startupPrompt?: StartupUnitApprovalPrompt;
    }
  ) {}

  enqueue(request: {
    entries: UnitBatchEntry[];
    trigger: "startup" | "meta-push";
    applyApproved(): Promise<void>;
    applyDenied(): void;
  }): Promise<void> {
    if (request.entries.length === 0) {
      return request.applyApproved();
    }
    let batch = this.pending.get(request.trigger);
    if (!batch) {
      batch = { trigger: request.trigger, requests: [], timer: null };
      this.pending.set(request.trigger, batch);
      batch.timer = setTimeout(() => {
        void this.flush(request.trigger);
      }, this.deps.delayMs ?? 0);
    }
    return new Promise<void>((resolve, reject) => {
      batch.requests.push({ ...request, resolve, reject });
    });
  }

  private async flush(trigger: "startup" | "meta-push"): Promise<void> {
    const batch = this.pending.get(trigger);
    if (!batch) return;
    this.pending.delete(trigger);
    if (batch.timer) clearTimeout(batch.timer);
    let requests = batch.requests;
    try {
      if (trigger === "startup" && this.deps.autoApproveStartup) {
        const promptRequests: PendingRequest[] = [];
        for (const request of requests) {
          if (request.entries.every((entry) => entry.unitKind === "app")) {
            await request.applyApproved();
            request.resolve();
          } else {
            promptRequests.push(request);
          }
        }
        requests = promptRequests;
        if (requests.length === 0) return;
      }
      const units = requests.flatMap((request) => request.entries);
      if (trigger === "startup" && this.deps.startupPrompt && units.length > 0) {
        const decision = await this.deps.startupPrompt.request({
          title: unitBatchTitle(units, trigger),
          description: unitBatchDescription(units),
          units,
        });
        if (decision === "deny") {
          for (const request of requests) request.applyDenied();
        } else {
          for (const request of requests) await request.applyApproved();
        }
        for (const request of requests) request.resolve();
        return;
      }
      const queuedUnits = requests.flatMap((request) => request.entries);
      const decision = await this.deps.approvalQueue.request({
        kind: "unit-batch",
        callerId: "system:units",
        callerKind: "system",
        repoPath: "meta",
        effectiveVersion: "",
        trigger,
        title: unitBatchTitle(queuedUnits, trigger),
        description: unitBatchDescription(queuedUnits),
        units: queuedUnits,
        configWrite: null,
      });
      if (decision === "deny") {
        for (const request of requests) request.applyDenied();
      } else {
        for (const request of requests) await request.applyApproved();
      }
      for (const request of requests) request.resolve();
    } catch (err) {
      for (const request of requests) request.reject(err);
    }
  }
}

function unitBatchTitle(units: UnitBatchEntry[], trigger: "startup" | "meta-push"): string {
  const hasApps = units.some((unit) => unit.unitKind === "app");
  const hasExtensions = units.some((unit) => unit.unitKind === "extension");
  if (hasApps && hasExtensions) {
    return trigger === "meta-push" ? "Workspace units changed" : "Approve workspace units";
  }
  if (hasApps) return trigger === "meta-push" ? "Workspace apps changed" : "Approve workspace apps";
  return trigger === "meta-push" ? "Workspace extensions changed" : "Approve workspace extensions";
}

function unitBatchDescription(units: UnitBatchEntry[]): string {
  const appCount = units.filter((unit) => unit.unitKind === "app").length;
  const extensionCount = units.filter((unit) => unit.unitKind === "extension").length;
  const parts: string[] = [];
  if (extensionCount > 0) {
    parts.push(
      `${extensionCount} extension${extensionCount === 1 ? "" : "s"} that run as native code`
    );
  }
  if (appCount > 0) {
    parts.push(`${appCount} privileged app${appCount === 1 ? "" : "s"} that run in the app host`);
  }
  return parts.length > 0
    ? `This workspace declares ${parts.join(" and ")}.`
    : "This push changes workspace configuration.";
}
