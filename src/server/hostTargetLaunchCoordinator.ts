import { randomBytes } from "node:crypto";
import { filterBootstrapApprovalsForTarget } from "@natstack/shared/bootstrapApprovals";
import type { PendingApproval, PendingUnitBatchApproval } from "@natstack/shared/approvals";
import { approvalViewModels, targetLabel } from "@natstack/shared/bootstrapLaunchGate";
import type { EventService } from "@natstack/shared/eventsService";
import type { HostTargetChangedPayload } from "@natstack/shared/events";
import type {
  HostTarget,
  HostTargetLaunchPhaseId,
  HostTargetLaunchSessionSnapshot,
  HostTargetLaunchSessionStatus,
  HostTargetLaunchResult,
} from "@natstack/shared/hostTargets";
import type { AppHost, ReactNativeHostReadiness } from "./appHost.js";

const BEGIN_LAUNCH_REFRESH_GRACE_MS = 250;

type UnitReconcileTrigger = "startup" | "meta-change";

interface ApprovalQueueLike {
  listPending(): PendingApproval[];
  resolve(approvalId: string, decision: "once" | "deny"): void;
}

interface StartupApprovalPublisher {
  publishPending(trigger?: UnitReconcileTrigger): void;
}

interface WorkspaceUnitStatusLike {
  kind: string;
  name: string;
  source: string;
  status: string;
  lastError?: string | null;
}

interface TrustedUnitHostLike {
  listWorkspaceUnits(): WorkspaceUnitStatusLike[];
}

export type MobileHostReadinessForPairing = {
  ready: boolean;
  reason?: string;
  details?: string[];
  source?: string | null;
  appId?: string | null;
  buildKey?: string;
  approvalRequired?: boolean;
  approvals?: PendingUnitBatchApproval[];
};

export interface HostTargetLaunchCoordinatorDeps {
  approvalQueue: ApprovalQueueLike;
  eventService: Pick<EventService, "emit">;
  startupApprovals: StartupApprovalPublisher;
  getAppHost(): AppHost | null;
  getTrustedUnitHosts(): TrustedUnitHostLike[];
}

export class HostTargetLaunchCoordinator {
  private revision = 0;
  private sessions = new Map<string, HostTargetLaunchSessionSnapshot>();

  constructor(private readonly deps: HostTargetLaunchCoordinatorDeps) {}

  pendingLaunchApprovals(target: HostTarget): PendingUnitBatchApproval[] {
    return filterBootstrapApprovalsForTarget(this.deps.approvalQueue.listPending(), target);
  }

  publishPendingStartupApprovals(target: HostTarget): PendingUnitBatchApproval[] {
    this.deps.startupApprovals.publishPending("startup");
    return this.pendingLaunchApprovals(target);
  }

  pendingOrPublishedStartupApprovals(target: HostTarget): PendingUnitBatchApproval[] {
    return this.publishPendingStartupApprovals(target);
  }

  async launch(target: HostTarget): Promise<HostTargetLaunchResult> {
    return await this.resolveLaunch(target);
  }

  async beginLaunch(target: HostTarget): Promise<HostTargetLaunchSessionSnapshot> {
    const existing = [...this.sessions.values()].find(
      (session) => session.target === target && !session.settled
    );
    if (existing) return await this.refreshSessionForBegin(existing.sessionId);

    const now = Date.now();
    const session: HostTargetLaunchSessionSnapshot = {
      sessionId: `launch_${randomBytes(12).toString("base64url")}`,
      target,
      status: "starting",
      currentPhase: "pair",
      message: `${targetLabel(target)} launch is starting.`,
      timeline: launchTimeline("starting", target, []),
      approvals: [],
      approvalViews: [],
      approvalsResolved: 0,
      startedAt: now,
      updatedAt: now,
      settled: false,
    };
    this.sessions.set(session.sessionId, session);
    return await this.refreshSessionForBegin(session.sessionId);
  }

  getLaunchSession(sessionId: string): HostTargetLaunchSessionSnapshot | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async resolveLaunchSessionApproval(
    sessionId: string,
    decision: "once" | "deny"
  ): Promise<HostTargetLaunchSessionSnapshot> {
    const session = this.requireSession(sessionId);
    const approvals = session.approvals;
    if (approvals.length === 0) {
      return await this.refreshSession(sessionId, { emit: true });
    }
    for (const approval of approvals) {
      this.deps.approvalQueue.resolve(approval.approvalId, decision);
    }
    if (decision === "deny") {
      const denied = {
        ...session,
        status: "denied" as const,
        currentPhase: "review-trust" as const,
        message: `${targetLabel(session.target)} launch was denied.`,
        detail: "No workspace app or extension code was started from this launch request.",
        approvalsResolved: session.approvalsResolved + approvals.length,
        updatedAt: Date.now(),
        settled: true,
        timeline: launchTimeline("denied", session.target, []),
      };
      this.sessions.set(sessionId, denied);
      this.emitSession(denied);
      return denied;
    }
    const approved = {
      ...session,
      status: "preparing" as const,
      currentPhase: "start-units" as const,
      message: `${targetLabel(session.target)} launch is starting approved units.`,
      detail: "Approved apps and extensions are being applied in dependency order.",
      approvals: [],
      approvalViews: [],
      approvalsResolved: session.approvalsResolved + approvals.length,
      updatedAt: Date.now(),
      settled: false,
      timeline: launchTimeline("preparing", session.target, [
        "Approved apps and extensions are being applied.",
      ]),
    };
    this.sessions.set(sessionId, approved);
    this.emitSession(approved);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return await this.refreshSession(sessionId, { emit: true });
  }

  cancelLaunchSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async ensureMobileHostReadyForPairing(
    source?: string | null
  ): Promise<MobileHostReadinessForPairing> {
    const pendingBeforeLaunch = this.pendingOrPublishedStartupApprovals("react-native");
    if (pendingBeforeLaunch.length > 0) {
      const readiness = approvalRequiredReadiness(
        pendingBeforeLaunch,
        "React Native workspace startup requires approval"
      );
      return readiness;
    }

    const appHost = this.deps.getAppHost();
    if (!appHost) {
      const readiness = unavailableReadiness("App host is not available");
      return readiness;
    }

    const readiness = await appHost.ensureReactNativeReady(source, { waitForApproval: false });
    if (readiness.ready) {
      return readiness;
    }

    const approvals = this.pendingOrPublishedStartupApprovals("react-native");
    if (
      approvals.length === 0 &&
      readiness.reason === "React Native build provider is not active"
    ) {
      const preparingDetails = this.reactNativePreparingDetails(readiness.details);
      if (preparingDetails) {
        const preparing = {
          ready: false,
          reason: "React Native workspace startup is preparing",
          details: preparingDetails,
          source: readiness.source,
          appId: readiness.appId,
        } satisfies MobileHostReadinessForPairing;
        return preparing;
      }
    }

    if (approvals.length > 0) {
      const approvalReadiness = approvalRequiredReadiness(
        approvals,
        "React Native workspace app requires approval",
        readiness
      );
      return approvalReadiness;
    }

    return readiness;
  }

  notifyTargetChanged(target: HostTarget, reason = "changed"): void {
    this.emitPayload({ target, status: "unknown", reason, revision: this.nextRevision() });
    void this.refreshSessionsForTarget(target);
  }

  notifyAllTargetsChanged(reason = "changed"): void {
    for (const target of ["electron", "react-native", "terminal"] satisfies HostTarget[]) {
      this.notifyTargetChanged(target, reason);
    }
  }

  private async resolveLaunch(target: HostTarget): Promise<HostTargetLaunchResult> {
    const pending = this.pendingOrPublishedStartupApprovals(target);
    if (pending.length > 0) return approvalRequiredResult(target, pending);

    const appHost = this.deps.getAppHost();
    if (!appHost) return unavailableResult(target, "App host is not available", []);

    const launch = await appHost.launchHostTarget(target);
    if (
      target === "react-native" &&
      launch.status === "unavailable" &&
      launch.reason === "React Native build provider is not active"
    ) {
      const approvals = this.pendingOrPublishedStartupApprovals("react-native");
      if (approvals.length > 0) return approvalRequiredResult(target, approvals);

      const preparingDetails = this.reactNativePreparingDetails(launch.details);
      if (preparingDetails) {
        return {
          status: "preparing",
          launched: false,
          target,
          reason: "React Native workspace startup is preparing",
          details: preparingDetails,
        };
      }
      return launch;
    }

    if (launch.status === "unavailable") {
      const approvals = this.pendingOrPublishedStartupApprovals(target);
      if (approvals.length > 0) return approvalRequiredResult(target, approvals);
    }

    return launch;
  }

  private async refreshSessionsForTarget(target: HostTarget): Promise<void> {
    const sessions = [...this.sessions.values()].filter(
      (session) => session.target === target && !session.settled
    );
    for (const session of sessions) {
      await this.refreshSession(session.sessionId, { emit: true }).catch(() => {});
    }
  }

  private async refreshSessionForBegin(
    sessionId: string
  ): Promise<HostTargetLaunchSessionSnapshot> {
    const refresh = this.refreshSession(sessionId, { emit: true }).catch((error: unknown) =>
      this.failSession(sessionId, error)
    );
    const delayed = new Promise<null>((resolve) =>
      setTimeout(resolve, BEGIN_LAUNCH_REFRESH_GRACE_MS)
    );
    const refreshed = await Promise.race([refresh, delayed]);
    return refreshed ?? this.requireSession(sessionId);
  }

  private failSession(sessionId: string, error: unknown): HostTargetLaunchSessionSnapshot {
    const previous = this.requireSession(sessionId);
    const message = error instanceof Error ? error.message : String(error);
    const next = this.snapshotFromLaunch(previous, {
      status: "unavailable",
      launched: false,
      target: previous.target,
      reason: message || `${targetLabel(previous.target)} launch failed.`,
      details: [],
    });
    this.sessions.set(sessionId, next);
    if (sessionChanged(previous, next)) this.emitSession(next);
    return next;
  }

  private async refreshSession(
    sessionId: string,
    opts: { emit?: boolean } = {}
  ): Promise<HostTargetLaunchSessionSnapshot> {
    const previous = this.requireSession(sessionId);
    const launch = await this.resolveLaunch(previous.target);
    const next = this.snapshotFromLaunch(previous, launch);
    this.sessions.set(sessionId, next);
    if (opts.emit && sessionChanged(previous, next)) this.emitSession(next);
    return next;
  }

  private snapshotFromLaunch(
    previous: HostTargetLaunchSessionSnapshot,
    launch: HostTargetLaunchResult
  ): HostTargetLaunchSessionSnapshot {
    const status = sessionStatusFromLaunch(launch);
    const approvals = launch.status === "approval-required" ? launch.approvals : [];
    const details =
      launch.status === "preparing" || launch.status === "unavailable" ? launch.details : [];
    return {
      ...previous,
      status,
      currentPhase: currentPhaseForStatus(status),
      message: messageForLaunch(launch),
      detail: detailForLaunch(launch),
      timeline: launchTimeline(status, previous.target, details),
      approvals,
      approvalViews: approvalViewModels(approvals),
      launch,
      updatedAt: Date.now(),
      settled: status === "ready" || status === "unavailable",
    };
  }

  private requireSession(sessionId: string): HostTargetLaunchSessionSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Launch session not found: ${sessionId}`);
    return session;
  }

  private emitSession(session: HostTargetLaunchSessionSnapshot): void {
    this.deps.eventService.emit("host-target-launch:session-changed", session);
  }

  private reactNativePreparingDetails(details: string[] = []): string[] | null {
    const building = this.deps
      .getTrustedUnitHosts()
      .flatMap((host) => host.listWorkspaceUnits())
      .filter(
        (unit) =>
          unit.status === "building" &&
          (unit.kind === "extension" ||
            unit.source === "apps/mobile" ||
            unit.name === "@workspace-apps/mobile")
      );
    if (building.length === 0) return null;
    return [
      ...details,
      ...building.map((unit) => `${unit.name} (${unit.source}) status: ${unit.status}`),
    ];
  }

  private emitPayload(payload: HostTargetChangedPayload): void {
    this.deps.eventService.emit("host-targets:changed", payload);
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }
}

function sessionStatusFromLaunch(launch: HostTargetLaunchResult): HostTargetLaunchSessionStatus {
  if (launch.status === "approval-required") return "approval-required";
  if (launch.status === "preparing") return "preparing";
  if (launch.status === "ready") return "ready";
  return "unavailable";
}

function currentPhaseForStatus(status: HostTargetLaunchSessionStatus): HostTargetLaunchPhaseId {
  if (status === "approval-required" || status === "denied") return "review-trust";
  if (status === "preparing") return "build-app";
  if (status === "ready") return "connected";
  if (status === "unavailable") return "build-app";
  return "pair";
}

function messageForLaunch(launch: HostTargetLaunchResult): string {
  const label = targetLabel(launch.target);
  if (launch.status === "approval-required") return `${label} launch needs your approval.`;
  if (launch.status === "preparing") return `${label} app is preparing.`;
  if (launch.status === "ready") return `${label} app is ready.`;
  return `${label} app is not available.`;
}

function detailForLaunch(launch: HostTargetLaunchResult): string | undefined {
  if (launch.status === "approval-required") {
    return `${launch.approvals.length} approval request${launch.approvals.length === 1 ? "" : "s"} must be reviewed before startup.`;
  }
  if (launch.status === "preparing" || launch.status === "unavailable") {
    const detail = launch.details.filter(Boolean).join("\n");
    return [launch.reason, detail].filter(Boolean).join("\n");
  }
  return `${launch.appId} from ${launch.source}${launch.buildKey ? ` build ${launch.buildKey}` : ""}`;
}

function launchTimeline(
  status: HostTargetLaunchSessionStatus,
  target: HostTarget,
  details: string[]
): HostTargetLaunchSessionSnapshot["timeline"] {
  const label = targetLabel(target);
  const buildDetail = details.find((detail) => /\bbuilding\b/i.test(detail)) ?? details[0];
  return [
    {
      id: "pair",
      label: "Connect",
      state: "complete",
      detail: "A trusted host connection is available.",
    },
    {
      id: "review-trust",
      label: "Review trust",
      state:
        status === "approval-required" ? "active" : status === "denied" ? "failed" : "complete",
      detail:
        status === "approval-required"
          ? "Review the workspace apps and extensions requesting trust."
          : undefined,
    },
    {
      id: "start-units",
      label: "Start privileged units",
      state:
        status === "approval-required" || status === "denied"
          ? "pending"
          : status === "preparing"
            ? "active"
            : status === "unavailable"
              ? "failed"
              : "complete",
      detail: status === "preparing" ? "Extensions are started before apps." : undefined,
    },
    {
      id: "build-app",
      label: `Build ${label.toLowerCase()} app`,
      state:
        status === "preparing"
          ? "active"
          : status === "ready"
            ? "complete"
            : status === "unavailable"
              ? "failed"
              : "pending",
      detail: status === "preparing" ? buildDetail : undefined,
    },
    {
      id: "activate-target",
      label: `Activate ${label.toLowerCase()}`,
      state: status === "ready" ? "complete" : status === "unavailable" ? "failed" : "pending",
    },
    {
      id: "connected",
      label: "Connected",
      state: status === "ready" ? "complete" : "pending",
    },
  ];
}

function sessionChanged(
  previous: HostTargetLaunchSessionSnapshot,
  next: HostTargetLaunchSessionSnapshot
): boolean {
  return (
    previous.status !== next.status ||
    previous.currentPhase !== next.currentPhase ||
    previous.message !== next.message ||
    previous.detail !== next.detail ||
    previous.approvals.map((approval) => approval.approvalId).join(",") !==
      next.approvals.map((approval) => approval.approvalId).join(",") ||
    previous.launch?.status !== next.launch?.status
  );
}

function approvalRequiredResult(
  target: HostTarget,
  approvals: PendingUnitBatchApproval[]
): HostTargetLaunchResult {
  return { status: "approval-required", launched: false, target, approvals };
}

function unavailableResult(
  target: HostTarget,
  reason: string,
  details: string[]
): HostTargetLaunchResult {
  return { status: "unavailable", launched: false, target, reason, details };
}

function unavailableReadiness(reason: string): MobileHostReadinessForPairing {
  return { ready: false, reason, details: [] };
}

function approvalRequiredReadiness(
  approvals: PendingUnitBatchApproval[],
  reason: string,
  readiness?: Extract<ReactNativeHostReadiness, { ready: false }>
): MobileHostReadinessForPairing {
  return {
    ready: false,
    approvalRequired: true,
    approvals,
    reason,
    details: readiness?.details ?? [],
    source: readiness?.source,
    appId: readiness?.appId,
  };
}
