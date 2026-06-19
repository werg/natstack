import type { PendingUnitBatchApproval, UnitBatchEntry } from "./approvals.js";
import type { HostTarget, HostTargetLaunchApprovalView } from "./hostTargets.js";

export type BootstrapDecision = "once" | "deny";

export interface UnitCounts {
  apps: number;
  extensions: number;
  desktop: number;
  mobile: number;
  terminal: number;
}

export interface LaunchGateCopy {
  title: string;
  summary: string;
}

export interface UnitReviewRow {
  name: string;
  source: string;
  capabilities: string;
  kind: string;
}

export function targetLabel(target: HostTarget): string {
  if (target === "react-native") return "Mobile";
  if (target === "terminal") return "Terminal";
  return "Desktop";
}

export function launchCopy(approval: PendingUnitBatchApproval): LaunchGateCopy {
  if (approval.trigger === "meta-change") {
    return {
      title: "Workspace code changed",
      summary:
        "The workspace configuration changed. Review the privileged workspace code before continuing.",
    };
  }
  return {
    title: "Apps and extensions requesting trust",
    summary: "Approving lets NatStack run the listed apps and extensions locally.",
  };
}

export function unitKindLabel(unit: UnitBatchEntry): string {
  if (unit.target === "electron") return "Desktop";
  if (unit.target === "react-native") return "Mobile";
  if (unit.target === "terminal") return "Terminal";
  if (unit.unitKind === "agent-heartbeat") return "Agent heartbeat";
  if (unit.unitKind === "scheduled-job") return "Scheduled job";
  return unit.unitKind === "extension" ? "Extension" : "App";
}

export function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

export function unitCounts(approval: PendingUnitBatchApproval): UnitCounts {
  return approval.units.reduce(
    (counts, unit) => {
      if (unit.unitKind === "app") counts.apps += 1;
      if (unit.unitKind === "extension") counts.extensions += 1;
      if (unit.target === "electron") counts.desktop += 1;
      if (unit.target === "react-native") counts.mobile += 1;
      if (unit.target === "terminal") counts.terminal += 1;
      return counts;
    },
    { apps: 0, extensions: 0, desktop: 0, mobile: 0, terminal: 0 }
  );
}

export function unitSummaryChips(approval: PendingUnitBatchApproval): string[] {
  const counts = unitCounts(approval);
  return [
    counts.apps > 0 ? plural(counts.apps, "app") : null,
    counts.extensions > 0 ? plural(counts.extensions, "extension") : null,
    counts.desktop > 0 ? plural(counts.desktop, "desktop app") : null,
    counts.mobile > 0 ? plural(counts.mobile, "mobile app") : null,
    counts.terminal > 0 ? plural(counts.terminal, "terminal app") : null,
  ].filter((item): item is string => item !== null);
}

export function formatCapabilities(unit: UnitBatchEntry): string {
  if (!unit.capabilities.length) return "No declared capabilities";
  return unit.capabilities.join(", ");
}

export function shortVersion(value?: string | null, length = 12): string {
  if (!value) return "none";
  return value.length <= length ? value : value.slice(0, length);
}

export function unitSourceLabel(unit: UnitBatchEntry): string {
  return `${unit.source.repo}@${unit.source.ref}${unit.ev ? ` - ${shortVersion(unit.ev)}` : ""}`;
}

export function unitReviewRows(approval: PendingUnitBatchApproval): UnitReviewRow[] {
  return approval.units.map((unit) => ({
    name: unit.displayName || unit.unitName,
    source: unitSourceLabel(unit),
    capabilities: formatCapabilities(unit),
    kind: unitKindLabel(unit),
  }));
}

export function approvalViewModel(
  approval: PendingUnitBatchApproval
): HostTargetLaunchApprovalView {
  const copy = launchCopy(approval);
  return {
    approvalId: approval.approvalId,
    title: copy.title,
    summary: copy.summary,
    chips: unitSummaryChips(approval),
    units: unitReviewRows(approval),
  };
}

export function approvalViewModels(
  approvals: PendingUnitBatchApproval[]
): HostTargetLaunchApprovalView[] {
  return approvals.map(approvalViewModel);
}

export function approvalSignature(approval: PendingUnitBatchApproval): string {
  return [
    approval.approvalId,
    approval.trigger,
    ...approval.units.map((unit) =>
      [
        unit.unitKind,
        unit.unitName,
        unit.target ?? "",
        unit.source.repo,
        unit.source.ref,
        unit.ev ?? "",
      ].join(":")
    ),
  ].join("|");
}

export function pendingSignature(approvals: PendingUnitBatchApproval[]): string {
  return approvals.map(approvalSignature).join("\n");
}

export function samePendingApprovals(
  left: PendingUnitBatchApproval[],
  right: PendingUnitBatchApproval[]
): boolean {
  return pendingSignature(left) === pendingSignature(right);
}

export function approvalIds(approvals: PendingUnitBatchApproval[]): Set<string> {
  return new Set(approvals.map((approval) => approval.approvalId));
}

export function formatLaunchGateForTerminal(
  approvals: PendingUnitBatchApproval[],
  target: HostTarget
): string {
  const lines = [`${targetLabel(target)} startup needs approval.`];
  for (const approval of approvals) {
    const copy = launchCopy(approval);
    lines.push("", copy.title, copy.summary);
    lines.push(`Units: ${plural(approval.units.length, "privileged unit")}`);
    const chips = unitSummaryChips(approval);
    if (chips.length > 0) lines.push(`Summary: ${chips.join(", ")}`);
    lines.push("Review details:");
    for (const row of unitReviewRows(approval)) {
      lines.push(`- ${row.name} [${row.kind}]`);
      lines.push(`  Source: ${row.source}`);
      lines.push(`  Capabilities: ${row.capabilities}`);
    }
  }
  return lines.join("\n");
}
