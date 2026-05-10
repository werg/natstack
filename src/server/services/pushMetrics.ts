export type PushSendOutcome = "sent" | "log-only" | "failed" | "no-registration";

export interface PushMetricsSnapshot {
  push_send_total: Record<string, number>;
  push_cancel_total: number;
  approval_resolved_total: Record<string, number>;
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export function createPushMetrics() {
  const pushSendTotal = new Map<string, number>();
  const approvalResolvedTotal = new Map<string, number>();
  let pushCancelTotal = 0;

  return {
    recordPushSend(labels: { platform: string; category: string; outcome: PushSendOutcome }): void {
      const key = labelKey(labels);
      pushSendTotal.set(key, (pushSendTotal.get(key) ?? 0) + 1);
    },

    recordPushCancel(): void {
      pushCancelTotal += 1;
    },

    recordApprovalResolved(labels: { decision: string; source: string }): void {
      const key = labelKey(labels);
      approvalResolvedTotal.set(key, (approvalResolvedTotal.get(key) ?? 0) + 1);
    },

    snapshot(): PushMetricsSnapshot {
      return {
        push_send_total: Object.fromEntries(pushSendTotal),
        push_cancel_total: pushCancelTotal,
        approval_resolved_total: Object.fromEntries(approvalResolvedTotal),
      };
    },
  };
}

export type PushMetrics = ReturnType<typeof createPushMetrics>;

export const pushMetrics = createPushMetrics();
