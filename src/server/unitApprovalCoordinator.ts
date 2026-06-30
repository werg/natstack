import type { UnitApprovalCoordinator, UnitApprovalDecision } from "@natstack/unit-host";
import type { PendingUnitBatchApproval, UnitBatchEntry } from "@natstack/shared/approvals";

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
  }): Promise<UnitApprovalDecision>;
}

interface PendingRequest {
  entries: UnitBatchEntry[];
  applyApproved(): Promise<void>;
  applyDenied(): void;
  resolve(): void;
  reject(error: unknown): void;
}

interface PendingBatch {
  trigger: "startup" | "meta-change";
  requests: PendingRequest[];
  timer: ReturnType<typeof setTimeout> | null;
}

export class ServerUnitApprovalCoordinator implements UnitApprovalCoordinator<UnitBatchEntry> {
  private pending = new Map<"startup" | "meta-change", PendingBatch>();

  constructor(
    private readonly deps: {
      approvalQueue: UnitApprovalQueueLike;
      delayMs?: number;
      autoApproveStartupUnits?: boolean;
    }
  ) {}

  enqueue(request: {
    entries: UnitBatchEntry[];
    trigger: "startup" | "meta-change";
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

  publishPending(trigger?: "startup" | "meta-change"): void {
    const triggers = trigger ? [trigger] : Array.from(this.pending.keys());
    for (const candidate of triggers) {
      void this.flush(candidate);
    }
  }

  private async flush(trigger: "startup" | "meta-change"): Promise<void> {
    const batch = this.pending.get(trigger);
    if (!batch) return;
    this.pending.delete(trigger);
    if (batch.timer) clearTimeout(batch.timer);
    const requests = batch.requests;
    try {
      const units = requests.flatMap((request) => request.entries);
      const decision =
        trigger === "startup" && this.deps.autoApproveStartupUnits
          ? "once"
          : await this.deps.approvalQueue.request({
              kind: "unit-batch",
              callerId: "system:units",
              callerKind: "system",
              repoPath: "meta",
              effectiveVersion: "",
              trigger,
              title: unitBatchTitle(units, trigger),
              description: unitBatchDescription(units),
              units,
              configWrite: null,
            });
      if (decision === "deny") {
        for (const request of requests) request.applyDenied();
      } else {
        for (const request of applyOrder(requests)) {
          await request.applyApproved();
        }
      }
      for (const request of requests) request.resolve();
    } catch (err) {
      for (const request of requests) request.reject(err);
    }
  }
}

function applyOrder(requests: PendingRequest[]): PendingRequest[] {
  return [...requests].sort((a, b) => requestApplyRank(a) - requestApplyRank(b));
}

function requestApplyRank(request: PendingRequest): number {
  return request.entries.some((entry) => entry.unitKind === "extension") ? 0 : 1;
}

function unitBatchTitle(units: UnitBatchEntry[], trigger: "startup" | "meta-change"): string {
  const hasApps = units.some((unit) => unit.unitKind === "app");
  const hasExtensions = units.some((unit) => unit.unitKind === "extension");
  if (hasApps && hasExtensions) {
    return trigger === "meta-change" ? "Workspace units changed" : "Approve workspace units";
  }
  if (hasApps)
    return trigger === "meta-change" ? "Workspace apps changed" : "Approve workspace apps";
  return trigger === "meta-change"
    ? "Workspace extensions changed"
    : "Approve workspace extensions";
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
