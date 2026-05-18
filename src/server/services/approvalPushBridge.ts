import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_STANDARD,
  type PushApprovalDataPayload,
} from "@natstack/shared/approvalContract";
import { getApprovalCopy } from "@natstack/shared/approvalCopy";
import type { PendingApproval } from "@natstack/shared/approvals";
import type { ApprovalQueueWithListeners } from "./approvalQueue.js";
import type { PushServiceInternal } from "./pushService.js";
import type { ShellPresenceInternal } from "./shellPresenceService.js";

interface ApprovalPushBridgeDeps {
  approvalQueue: Pick<ApprovalQueueWithListeners, "listPending" | "onPendingChanged">;
  push: PushServiceInternal;
  shellPresence: ShellPresenceInternal;
  delayMs?: number;
  presenceMaxAgeMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ApprovalPushBridge {
  stop(): void;
}

interface TrackedApproval {
  approval: PendingApproval;
  timers: ReturnType<typeof setTimeout>[];
  sent: boolean;
}

function categoryFor(approval: PendingApproval): string {
  return approval.kind === "credential" ||
    approval.kind === "capability" ||
    approval.kind === "extension"
    ? APPROVAL_CATEGORY_DECIDE
    : APPROVAL_CATEGORY_INPUT_REQUIRED;
}

function actionsFor(approval: PendingApproval): readonly string[] {
  if (approval.kind === "extension") return ["once", "deny", "open"];
  return approval.kind === "credential" || approval.kind === "capability"
    ? NOTIFICATION_ACTION_IDS_STANDARD
    : NOTIFICATION_ACTION_IDS_INPUT_REQUIRED;
}

const ACTION_TITLES: Record<string, string> = {
  once: "Once",
  session: "Session",
  deny: "Deny",
  open: "Open",
  version: "Trust Version",
  repo: "Trust Repo",
};

function actionPayloadFor(approval: PendingApproval): Array<{ id: string; title: string }> {
  return actionsFor(approval).map((id) => ({
    id,
    title: approval.kind === "extension" && id === "once" ? "Approve" : (ACTION_TITLES[id] ?? id),
  }));
}

function callerLabel(approval: PendingApproval): string {
  return approval.callerKind === "worker" ? "Worker" : "Panel";
}

function payloadFor(
  approval: PendingApproval,
  title: string,
  body: string,
  category: string
): PushApprovalDataPayload {
  return {
    kind: "approval-prompt",
    approvalId: approval.approvalId,
    approvalKind: approval.kind,
    title,
    body,
    category,
    cancelKey: approval.approvalId,
    actionsJson: JSON.stringify(actionPayloadFor(approval)),
  };
}

export function createApprovalPushBridge(deps: ApprovalPushBridgeDeps): ApprovalPushBridge {
  const delayMs = deps.delayMs ?? 10_000;
  const presenceMaxAgeMs = deps.presenceMaxAgeMs ?? 6_000;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const tracked = new Map<string, TrackedApproval>();

  async function sendApproval(approval: PendingApproval): Promise<boolean> {
    const category = categoryFor(approval);
    const copy = getApprovalCopy(approval, callerLabel(approval));
    const body = copy.warning ? `${copy.summary} ${copy.warning}` : copy.summary;
    const results = await deps.push.sendBatch({
      title: copy.title,
      body,
      category,
      data: payloadFor(approval, copy.title, body, category),
    });
    return results.some((result) => result.sent);
  }

  function trackNewApproval(approval: PendingApproval): void {
    const trackedApproval: TrackedApproval = {
      approval,
      timers: [],
      sent: false,
    };
    tracked.set(approval.approvalId, trackedApproval);

    const sendIfPending = (reason: "presence-stale" | "deadline") => {
      if (!tracked.has(approval.approvalId) || trackedApproval.sent) return;
      if (reason === "presence-stale" && deps.shellPresence.isAnyShellActive(presenceMaxAgeMs)) {
        return;
      }
      for (const timer of trackedApproval.timers) {
        clearTimeoutFn(timer);
      }
      trackedApproval.timers = [];
      void sendApproval(approval)
        .then((sent) => {
          trackedApproval.sent = sent;
        })
        .catch((error) => {
          console.warn("[ApprovalPushBridge] delayed push send failed:", error);
        });
    };

    if (deps.shellPresence.isAnyShellActive()) {
      trackedApproval.timers.push(
        setTimeoutFn(() => sendIfPending("presence-stale"), presenceMaxAgeMs)
      );
      trackedApproval.timers.push(setTimeoutFn(() => sendIfPending("deadline"), delayMs));
      return;
    }

    void sendApproval(approval)
      .then((sent) => {
        trackedApproval.sent = sent;
      })
      .catch((error) => {
        console.warn("[ApprovalPushBridge] push send failed:", error);
      });
  }

  function cancelTracked(approvalId: string): void {
    const existing = tracked.get(approvalId);
    if (!existing) return;
    for (const timer of existing.timers) {
      clearTimeoutFn(timer);
    }
    tracked.delete(approvalId);
    if (!existing.sent) return;
    void deps.push.cancel(approvalId).catch((error) => {
      console.warn("[ApprovalPushBridge] push cancel failed:", error);
    });
  }

  function onPendingChanged(pending: PendingApproval[]): void {
    const pendingIds = new Set(pending.map((approval) => approval.approvalId));
    for (const approvalId of tracked.keys()) {
      if (!pendingIds.has(approvalId)) {
        cancelTracked(approvalId);
      }
    }
    for (const approval of pending) {
      if (!tracked.has(approval.approvalId)) {
        trackNewApproval(approval);
      }
    }
  }

  const unsubscribe = deps.approvalQueue.onPendingChanged(onPendingChanged);
  onPendingChanged(deps.approvalQueue.listPending());

  return {
    stop() {
      unsubscribe();
      for (const approvalId of [...tracked.keys()]) {
        cancelTracked(approvalId);
      }
    },
  };
}
