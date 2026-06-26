// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type {
  PendingCapabilityApproval,
  PendingClientConfigApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
} from "@natstack/shared/approvals";
import { ApprovalCard } from "./ApprovalCard";
import { resolveCallerInfo, type ApprovalCardIntent } from "./approvalCardModel";
import { ApprovalCardSurface } from "../overlay/ApprovalCardSurface";

function userlandApproval(
  partial: Partial<PendingUserlandApproval> & { approvalId: string; title: string }
): PendingUserlandApproval {
  return {
    kind: "userland",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    callerTitle: partial.callerTitle,
    subject: partial.subject ?? { id: "sub-1", label: "Subject" },
    title: partial.title,
    summary: partial.summary,
    promptOptions: partial.promptOptions ?? "choices",
    options: partial.options ?? [{ value: "ok", label: "OK", tone: "primary" }],
    approvalId: partial.approvalId,
  };
}

function capabilityApproval(
  partial: Partial<PendingCapabilityApproval> & { approvalId: string; title: string }
): PendingCapabilityApproval {
  return {
    kind: "capability",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    capability: partial.capability ?? "context.boundary",
    severity: partial.severity,
    title: partial.title,
    description: partial.description,
    resource: partial.resource ?? { type: "panel", label: "Panel", value: "Shell" },
    grantResourceKey: partial.grantResourceKey,
    details: partial.details,
    approvalId: partial.approvalId,
  };
}

function unitBatchApproval(
  partial: Partial<PendingUnitBatchApproval> & { approvalId: string }
): PendingUnitBatchApproval {
  return {
    kind: "unit-batch",
    trigger: partial.trigger ?? "source-change",
    callerId: partial.callerId ?? "system:units",
    callerKind: partial.callerKind ?? "system",
    repoPath: partial.repoPath ?? "meta",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    title: partial.title ?? "Approve workspace extensions",
    description: partial.description ?? "This workspace declares extensions.",
    approvalId: partial.approvalId,
    units:
      partial.units ??
      Array.from({ length: 2 }, (_, index) => ({
        unitKind: "extension" as const,
        unitName: `@workspace-extensions/ext-${index + 1}`,
        displayName: `Extension ${index + 1}`,
        version: "0.1.0",
        source: {
          kind: "workspace-repo" as const,
          repo: `extensions/ext-${index + 1}`,
          ref: "main",
        },
        ev: `ev-${index + 1}`,
        capabilities: ["node:fs", "node:process"],
      })),
  };
}

function clientConfigApproval(
  partial: Partial<PendingClientConfigApproval> & { approvalId: string; configId: string }
): PendingClientConfigApproval {
  return {
    kind: "client-config",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    approvalId: partial.approvalId,
    configId: partial.configId,
    authorizeUrl: partial.authorizeUrl ?? "https://accounts.example.test/oauth/authorize",
    tokenUrl: partial.tokenUrl ?? "https://accounts.example.test/oauth/token",
    title: partial.title ?? partial.configId,
    description: partial.description,
    fields: partial.fields ?? [
      { name: "clientSecret", label: "Client Secret", type: "secret", required: true },
    ],
  };
}

function renderCard(
  approval: Parameters<typeof resolveCallerInfo>[0],
  opts: { queue?: Parameters<typeof ApprovalCard>[0]["queue"]; decisionError?: string | null } = {}
) {
  const emit = vi.fn<(intent: ApprovalCardIntent) => void>();
  render(
    <Theme>
      <ApprovalCard
        approval={approval}
        caller={resolveCallerInfo(approval)}
        queue={opts.queue ?? null}
        decisionError={opts.decisionError ?? null}
        emit={emit}
      />
    </Theme>
  );
  return { emit };
}

describe("ApprovalCard", () => {
  it("renders a severe capability with a danger tone and emits a version decision", () => {
    const { emit } = renderCard(
      capabilityApproval({
        approvalId: "cap-severe",
        title: "Act on Shell's context",
        severity: "severe",
      })
    );
    const card = screen
      .getByText("Act on Shell's context")
      .closest(".approval-card") as HTMLElement;
    expect(card.getAttribute("data-approval-tone")).toBe("red");

    const trustButton = screen.getByText("Trust version").closest("button");
    expect(trustButton?.getAttribute("data-accent-color")).toBe("red");
    fireEvent.click(trustButton as HTMLButtonElement);
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "version",
      approvalId: "cap-severe",
    });
  });

  it("shows the queue navigator and emits browse intents", () => {
    const { emit } = renderCard(userlandApproval({ approvalId: "a1", title: "First approval" }), {
      queue: { index: 0, total: 3, canPrev: false, canNext: true },
    });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next approval"));
    expect(emit).toHaveBeenCalledWith({ type: "browse", dir: "next", approvalId: "a1" });
  });

  it("omits the navigator for a single approval", () => {
    renderCard(userlandApproval({ approvalId: "solo", title: "Lonely approval" }), { queue: null });
    expect(screen.queryByLabelText("Next approval")).toBeNull();
  });

  it("surfaces a decision error", () => {
    renderCard(userlandApproval({ approvalId: "err", title: "Boom" }), {
      decisionError: "resolve blocked",
    });
    expect(screen.getByText("Approval action failed: resolve blocked")).toBeTruthy();
  });

  it("emits decide intents for a unit-batch and keeps its entries collapsed", () => {
    const { emit } = renderCard(
      unitBatchApproval({ approvalId: "extensions", title: "Approve workspace extensions" })
    );
    const firstUnit = screen
      .getByText("Extension 1 · v0.1.0")
      .closest("details") as HTMLDetailsElement;
    expect(firstUnit.open).toBe(false);

    fireEvent.click(screen.getByText("Approve change"));
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "once",
      approvalId: "extensions",
    });
    fireEvent.click(screen.getByText("Deny"));
    expect(emit).toHaveBeenCalledWith({
      type: "decide",
      decision: "deny",
      approvalId: "extensions",
    });
  });

  it("emits a minimize intent from the header control", () => {
    const { emit } = renderCard(userlandApproval({ approvalId: "m", title: "Minimizable" }));
    fireEvent.click(screen.getByLabelText("Minimize approval"));
    expect(emit).toHaveBeenCalledWith({ type: "minimize", approvalId: "m" });
  });

  it("remounts the overlay card when the approval changes so secret inputs reset", () => {
    const first = clientConfigApproval({ approvalId: "setup-a", configId: "service-a" });
    const second = clientConfigApproval({ approvalId: "setup-b", configId: "service-b" });
    const emitIntent = vi.fn<(intent: unknown) => void>();
    const { rerender } = render(
      <Theme>
        <ApprovalCardSurface
          props={{ approval: first, queue: null, decisionError: null }}
          emitIntent={emitIntent}
        />
      </Theme>
    );

    const firstInput = screen.getByPlaceholderText("Client Secret") as HTMLInputElement;
    fireEvent.change(firstInput, { target: { value: "first-secret" } });
    expect(firstInput.value).toBe("first-secret");

    rerender(
      <Theme>
        <ApprovalCardSurface
          props={{ approval: second, queue: null, decisionError: null }}
          emitIntent={emitIntent}
        />
      </Theme>
    );

    expect((screen.getByPlaceholderText("Client Secret") as HTMLInputElement).value).toBe("");
  });
});
