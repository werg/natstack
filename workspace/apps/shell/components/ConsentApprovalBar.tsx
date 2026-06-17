import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Flex,
  IconButton,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  EnterIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  GearIcon,
  GlobeIcon,
  LockClosedIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import type {
  ApprovalDecision,
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingClientConfigApproval,
  PendingDeviceCodeApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
} from "@natstack/shared/approvals";
import {
  formatAccount,
  formatInjection,
  getApprovalAttribution,
  getApprovalCopy,
  getStandardActionCopy,
  getUnitBatchActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "@natstack/shared/approvalCopy";
import { filterRuntimeApprovals } from "@natstack/shared/bootstrapApprovals";
import { useShellEvent } from "../shell/useShellEvent";
import { shellApproval, shellPresence } from "../shell/client";
import { useNavigation } from "./NavigationContext";

interface CallerInfo {
  /** Friendly user-visible label — panel title, worker source basename, etc. */
  label: string;
  /** Caller kind, formatted for display ("Panel" / "Worker" / "Service"). */
  kindLabel: string;
  /** Caller kind as accepted by the approval payload. */
  kind: "panel" | "app" | "worker" | "do";
  /** Set when this caller refers to a panel that exists in the live tree. */
  panelId?: string;
  /** Truncated id, retained for the expandable details panel. */
  shortId: string;
}

function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function prettifyId(callerId: string): string {
  // Drop common prefixes ("do-service:", "do:", "worker:") and trim noise.
  return callerId.replace(/^(do-service:|do:|worker:|panel:)/, "");
}

export function ConsentApprovalBar() {
  const [pendingAccess, setPendingAccess] = useState<PendingApproval[]>([]);
  const [secretConfigValues, setSecretConfigValues] = useState<Record<string, string>>({});
  const [decisionError, setDecisionError] = useState<{
    approvalId: string;
    message: string;
  } | null>(null);
  const pendingAccessRefreshSeq = useRef(0);
  const { navigateToId } = useNavigation();

  const refreshPendingAccess = useCallback(async () => {
    const seq = ++pendingAccessRefreshSeq.current;
    try {
      const list = await shellApproval.listPending();
      if (seq === pendingAccessRefreshSeq.current) {
        setPendingAccess(filterRuntimeApprovals(list));
      }
    } catch (err) {
      console.warn("[ConsentApprovalBar] listPending failed:", err);
    }
  }, []);

  useShellEvent(
    "shell-approval:pending-changed",
    useCallback(
      (event) => {
        if (Array.isArray(event?.pending)) {
          pendingAccessRefreshSeq.current++;
          setPendingAccess(filterRuntimeApprovals(event.pending));
          return;
        }
        void refreshPendingAccess();
      },
      [refreshPendingAccess]
    )
  );

  useEffect(() => {
    const heartbeat = () => {
      void shellPresence
        .heartbeat()
        .catch((err: unknown) => console.warn("[ConsentApprovalBar] heartbeat failed:", err));
    };
    heartbeat();
    const intervalId = window.setInterval(heartbeat, 5_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    void refreshPendingAccess();
    const intervalId = window.setInterval(() => {
      void refreshPendingAccess();
    }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [refreshPendingAccess]);

  // Replays the attention pulse whenever a not-yet-seen approval enters the
  // queue — including ones that line up behind the currently shown approval,
  // which otherwise change nothing but the "1 / N" counter.
  const [attentionSeq, setAttentionSeq] = useState(0);
  const seenApprovalIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(pendingAccess.map((approval) => approval.approvalId));
    const hasNew = pendingAccess.some(
      (approval) => !seenApprovalIdsRef.current.has(approval.approvalId)
    );
    seenApprovalIdsRef.current = ids;
    if (hasNew) setAttentionSeq((seq) => seq + 1);
  }, [pendingAccess]);

  // Browsable index into pendingAccess. Stays put when later items resolve,
  // clamps when the visible item disappears (the most natural fallback is to
  // stay at the same index — the next pending slides into view).
  const [browseIndex, setBrowseIndex] = useState(0);
  useEffect(() => {
    setBrowseIndex((idx) => {
      if (pendingAccess.length === 0) return 0;
      if (idx >= pendingAccess.length) return pendingAccess.length - 1;
      return idx;
    });
  }, [pendingAccess.length]);

  const current = pendingAccess[browseIndex] ?? pendingAccess[0] ?? null;
  const queueLength = pendingAccess.length;
  const canPrev = queueLength > 1 && browseIndex > 0;
  const canNext = queueLength > 1 && browseIndex < queueLength - 1;

  useEffect(() => {
    setSecretConfigValues({});
    setDecisionError((error) => (error && error.approvalId !== current?.approvalId ? null : error));
  }, [current?.approvalId]);

  const resolveCallerInfo = useCallback((approval: PendingApproval): CallerInfo => {
    const shortId = truncateId(approval.callerId);
    // Authoritative title comes from the server-side entity-title registry
    // (populated by `runtime.setTitle` for workers/DOs and by the
    // workspace-state panel.* mirror for panels). We no longer cross-check
    // the renderer's panel tree — the server is the single source of
    // truth, and mobile workspace apps don't have a panel tree anyway. If the
    // server doesn't know a title yet, fall back to a derived id-ish label.
    const serverTitle = approval.callerTitle?.trim() || undefined;
    if (approval.callerKind === "panel") {
      return {
        label: serverTitle ?? prettifyId(approval.callerId),
        kindLabel: "Panel",
        kind: "panel",
        // The "Show panel" action is offered unconditionally — the
        // navigation callback is a no-op for unknown ids, so it's safe.
        panelId: approval.callerId,
        shortId,
      };
    }
    if (approval.callerKind === "worker") {
      const fromRepo = basename(approval.repoPath);
      return {
        label: serverTitle ?? fromRepo ?? prettifyId(approval.callerId),
        kindLabel: "Worker",
        kind: "worker",
        shortId,
      };
    }
    if (approval.callerKind === "app") {
      const fromRepo = basename(approval.repoPath);
      return {
        label: serverTitle ?? fromRepo ?? prettifyId(approval.callerId),
        kindLabel: "App",
        kind: "app",
        shortId,
      };
    }
    if (approval.callerKind === "system") {
      return {
        label: serverTitle ?? "Workspace",
        kindLabel: "Workspace",
        kind: "do",
        shortId,
      };
    }
    // Durable-object service or unknown — show the trailing segment of the id.
    const id = prettifyId(approval.callerId);
    const segments = id.split(":");
    return {
      label: serverTitle ?? segments[segments.length - 1] ?? id,
      kindLabel: "Service",
      kind: "do",
      shortId,
    };
  }, []);

  const currentCaller = current ? resolveCallerInfo(current) : null;

  const showRequestingPanel = useCallback(() => {
    if (currentCaller?.panelId) {
      navigateToId(currentCaller.panelId);
    }
  }, [currentCaller, navigateToId]);

  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!current) {
      return;
    }
    const el = barRef.current;
    const update = () => {
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    };
    update();
    const observer = el ? new ResizeObserver(update) : null;
    if (el) observer?.observe(el);
    return () => {
      observer?.disconnect();
    };
  }, [current]);

  if (!current) return null;

  const decide = (decision: ApprovalDecision) => {
    const approval = current;
    setDecisionError(null);
    setPendingAccess((items) => items.filter((item) => item.approvalId !== approval.approvalId));
    void shellApproval
      .resolve(approval.approvalId, decision)
      .then(() => refreshPendingAccess())
      .catch((err: unknown) => {
        console.error("[ConsentApprovalBar] resolve failed:", err);
        const message = err instanceof Error ? err.message : String(err);
        setPendingAccess((items) =>
          items.some((item) => item.approvalId === approval.approvalId)
            ? items
            : [approval, ...items]
        );
        setDecisionError({
          approvalId: approval.approvalId,
          message: message || "Approval decision failed.",
        });
      });
  };
  const submitClientConfig = () => {
    if (current?.kind !== "client-config") return;
    void shellApproval
      .submitClientConfig(current.approvalId, secretConfigValues)
      .catch((err: unknown) =>
        console.error("[ConsentApprovalBar] submitClientConfig failed:", err)
      );
  };
  const submitCredentialInput = () => {
    if (current?.kind !== "credential-input") return;
    void shellApproval
      .submitCredentialInput(current.approvalId, secretConfigValues)
      .catch((err: unknown) =>
        console.error("[ConsentApprovalBar] submitCredentialInput failed:", err)
      );
  };
  const resolveUserland = (choice: string | "dismiss") => {
    if (current?.kind !== "userland") return;
    void shellApproval
      .resolveUserland(current.approvalId, choice)
      .catch((err: unknown) => console.error("[ConsentApprovalBar] resolveUserland failed:", err));
  };

  if (!currentCaller) return null;
  const copy = getApprovalCopy(current);
  const attribution = getApprovalAttribution(current);
  const isUnitApproval = current.kind === "unit-batch";
  const accent = approvalAccent(current);
  // Drive the bar palette through CSS variables on a single class so the
  // light/dark overrides in overrides.css remain authoritative.
  const toneStyle = {
    "--app-approval-bg": `var(--app-approval-${accent}-bg)`,
    "--app-approval-border": `var(--app-approval-${accent}-border)`,
    "--app-approval-stripe": `var(--app-approval-${accent}-stripe)`,
    "--app-approval-text": `var(--app-approval-${accent}-text)`,
  } as CSSProperties;

  return (
    <Box
      ref={barRef}
      data-shell-top-chrome="approval-bar"
      key={current.approvalId}
      className="approval-bar"
      style={{
        ...toneStyle,
        flexShrink: 0,
      }}
    >
      <span key={attentionSeq} className="approval-attention-pulse" aria-hidden="true" />
      <Flex direction="column" gap="3" px="4" py="3">
        <Flex align="start" gap="3">
          <Box className="approval-icon-box">
            {isUnitApproval ? (
              <ExclamationTriangleIcon width={18} height={18} />
            ) : current.kind === "device-code" ? (
              <ExternalLinkIcon width={18} height={18} />
            ) : current.kind === "capability" ? (
              <GlobeIcon width={18} height={18} />
            ) : current.kind === "client-config" || current.kind === "credential-input" ? (
              <GearIcon width={18} height={18} />
            ) : (
              <LockClosedIcon width={18} height={18} />
            )}
          </Box>

          <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Text
                size="3"
                weight="bold"
                style={{
                  lineHeight: 1.25,
                  color: "var(--app-approval-text)",
                  overflowWrap: "anywhere",
                }}
              >
                {copy.title}
              </Text>
              {queueLength > 1 ? (
                <QueueNavigator
                  index={browseIndex}
                  total={queueLength}
                  canPrev={canPrev}
                  canNext={canNext}
                  onPrev={() => setBrowseIndex((idx) => Math.max(0, idx - 1))}
                  onNext={() => setBrowseIndex((idx) => Math.min(queueLength - 1, idx + 1))}
                />
              ) : null}
            </Flex>

            <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
              <CallerChip caller={currentCaller} onShow={showRequestingPanel} />
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                {currentCaller.kindLabel.toLowerCase()}
              </Text>
              {attribution.target ? (
                <>
                  <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                    {attribution.relation ?? "for"}
                  </Text>
                  <span className="approval-caller-chip" data-clickable="false">
                    <span className="approval-caller-chip-title">{attribution.target}</span>
                  </span>
                </>
              ) : null}
            </Flex>

            {copy.warning ? (
              <Flex align="center" gap="1" style={{ color: "var(--red-11)" }}>
                <ExclamationTriangleIcon width={13} height={13} />
                <Text size="1" style={{ lineHeight: 1.35 }}>
                  {copy.warning}
                </Text>
              </Flex>
            ) : null}
            {decisionError && decisionError.approvalId === current.approvalId ? (
              <Flex align="center" gap="1" style={{ color: "var(--red-11)" }}>
                <ExclamationTriangleIcon width={13} height={13} />
                <Text size="1" style={{ lineHeight: 1.35 }}>
                  Approval action failed: {decisionError.message}
                </Text>
              </Flex>
            ) : null}

            <ApprovalDetails
              approval={current}
              caller={currentCaller}
              defaultOpen={shouldOpenApprovalDetails(current)}
            />
            {current.kind === "device-code" ? <DeviceCodeBody approval={current} /> : null}
            {current.kind === "client-config" || current.kind === "credential-input" ? (
              <SecretConfigFields
                approval={current}
                values={secretConfigValues}
                onChange={(name, value) =>
                  setSecretConfigValues((previous) => ({ ...previous, [name]: value }))
                }
              />
            ) : null}
          </Flex>
        </Flex>

        <Flex justify="end" wrap="wrap" gap="2" style={{ flexShrink: 0 }}>
          {current.kind === "client-config" ? (
            <ClientConfigActions
              approval={current}
              values={secretConfigValues}
              onSubmit={submitClientConfig}
              onDeny={() => decide("deny")}
              onDismiss={() => decide("dismiss")}
            />
          ) : current.kind === "credential-input" ? (
            <CredentialInputActions
              approval={current}
              values={secretConfigValues}
              onSubmit={submitCredentialInput}
              onDeny={() => decide("deny")}
              onDismiss={() => decide("dismiss")}
            />
          ) : current.kind === "userland" ? (
            <UserlandApprovalActions approval={current} onChoose={resolveUserland} />
          ) : current.kind === "device-code" ? (
            <DeviceCodeActions onCancel={() => decide("dismiss")} />
          ) : current.kind === "unit-batch" ? (
            <UnitBatchActions approval={current} decide={decide} />
          ) : (
            <StandardApprovalActions approval={current} decide={decide} />
          )}
        </Flex>
      </Flex>
    </Box>
  );
}

function approvalAccent(approval: PendingApproval): "sky" | "amber" | "red" {
  if (approval.kind === "capability" && approval.severity === "severe") return "red";
  if (approval.kind === "unit-batch") {
    if (approval.units.some((unit) => unit.unitKind === "extension")) return "red";
    return "amber";
  }
  return "sky";
}

function QueueNavigator({
  index,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <Flex align="center" gap="1" style={{ marginLeft: "auto", flexShrink: 0 }}>
      <Tooltip content={canPrev ? "Previous pending approval" : "No earlier approvals"}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={!canPrev}
          onClick={onPrev}
          aria-label="Previous approval"
        >
          <ChevronLeftIcon />
        </IconButton>
      </Tooltip>
      <Text size="1" color="gray" style={{ minWidth: 32, textAlign: "center" }}>
        {index + 1} / {total}
      </Text>
      <Tooltip content={canNext ? "Next pending approval" : "No more approvals"}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={!canNext}
          onClick={onNext}
          aria-label="Next approval"
        >
          <ChevronRightIcon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function CallerChip({ caller, onShow }: { caller: CallerInfo; onShow: () => void }) {
  const clickable = caller.panelId !== undefined;
  const tooltip = clickable
    ? `Show panel — ${caller.label} (${caller.shortId})`
    : `${caller.kindLabel} ${caller.shortId}`;
  return (
    <Tooltip content={tooltip}>
      <span
        className="approval-caller-chip"
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        data-clickable={clickable ? "true" : "false"}
        onClick={clickable ? onShow : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onShow();
                }
              }
            : undefined
        }
      >
        <span className="approval-caller-chip-kind" aria-hidden="true">
          {caller.kind === "panel" ? (
            <EnterIcon width={11} height={11} />
          ) : caller.kind === "worker" ? (
            <PersonIcon width={11} height={11} />
          ) : (
            <GearIcon width={11} height={11} />
          )}
        </span>
        <span className="approval-caller-chip-title">{caller.label}</span>
      </span>
    </Tooltip>
  );
}

function StandardApprovalActions({
  approval,
  decide,
}: {
  approval: PendingCredentialApproval | PendingCapabilityApproval;
  decide: (decision: ApprovalDecision) => void;
}) {
  const copy = getStandardActionCopy(approval);
  const isSevereCapability = approval.kind === "capability" && approval.severity === "severe";
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <DecisionButton
        label={copy.once.label}
        description={copy.once.description}
        variant="surface"
        onClick={() => decide("once")}
      />
      <DecisionButton
        label={copy.session.label}
        description={copy.session.description}
        variant="surface"
        onClick={() => decide("session")}
      />
      <DecisionButton
        label={copy.version.label}
        description={copy.version.description}
        color={isSevereCapability ? "red" : "sky"}
        variant="solid"
        onClick={() => decide("version")}
      />
      <DecisionButton
        label="Deny"
        description={copy.denyDescription}
        color="red"
        icon={<CrossCircledIcon />}
        style={{ marginLeft: 6 }}
        onClick={() => decide("deny")}
      />
      <Tooltip content="Dismiss">
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function UnitBatchActions({
  approval,
  decide,
}: {
  approval: PendingUnitBatchApproval;
  decide: (decision: ApprovalDecision) => void;
}) {
  const copy = getUnitBatchActionCopy(approval);
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <DecisionButton
        label={copy.once.label}
        description={copy.once.description}
        color="amber"
        variant="solid"
        onClick={() => decide("once")}
      />
      {copy.session ? (
        <DecisionButton
          label={copy.session.label}
          description={copy.session.description}
          variant="surface"
          onClick={() => decide("session")}
        />
      ) : null}
      <DecisionButton
        label={copy.deny.label}
        description={copy.deny.description}
        color="red"
        icon={<CrossCircledIcon />}
        style={{ marginLeft: 6 }}
        onClick={() => decide("deny")}
      />
      <Tooltip content="Dismiss">
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function ClientConfigActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss,
}: {
  approval: PendingClientConfigApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired ? "Enter the required fields first." : "Save this connected service."
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          Save service
        </Button>
      </Tooltip>
      <DecisionButton
        label="Deny"
        description="Do not save this connected service."
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content="Dismiss">
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function CredentialInputActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss,
}: {
  approval: PendingCredentialInputApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired ? "Enter the required secret first." : "Save this connected service."
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          Save service
        </Button>
      </Tooltip>
      <DecisionButton
        label="Deny"
        description="Do not save this connected service."
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content="Dismiss">
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function UserlandApprovalActions({
  approval,
  onChoose,
}: {
  approval: PendingUserlandApproval;
  onChoose: (choice: string | "dismiss") => void;
}) {
  return (
    <Flex direction="column" align="end" gap="1">
      <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
        {approval.options.map((option) => (
          <DecisionButton
            key={option.value}
            label={option.label}
            description={option.description ?? option.label}
            color={option.tone === "danger" ? "red" : option.tone === "primary" ? "sky" : undefined}
            variant={option.tone === "primary" ? "solid" : "surface"}
            icon={option.tone === "danger" ? <CrossCircledIcon /> : <CheckCircledIcon />}
            onClick={() => onChoose(option.value)}
          />
        ))}
        <Tooltip content="Dismiss">
          <IconButton size="1" variant="ghost" color="gray" onClick={() => onChoose("dismiss")}>
            <Cross2Icon />
          </IconButton>
        </Tooltip>
      </Flex>
      <Text size="1" color="gray">
        {approval.promptOptions === "scoped"
          ? "Use Trust version to remember this approval."
          : "Remembered until revoked."}
      </Text>
    </Flex>
  );
}

function DecisionButton({
  label,
  description,
  color,
  variant = "soft",
  icon = <CheckCircledIcon />,
  style,
  onClick,
}: {
  label: string;
  description: string;
  color?: "amber" | "red" | "sky";
  variant?: "solid" | "soft" | "surface" | "outline";
  icon?: ReactNode;
  style?: CSSProperties;
  onClick: () => void;
}) {
  return (
    <Tooltip content={description}>
      <Button size="1" variant={variant} color={color} style={style} onClick={onClick}>
        {icon}
        {label}
      </Button>
    </Tooltip>
  );
}

function DeviceCodeBody({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <Box
      mt="1"
      p="2"
      style={{
        border: "1px solid var(--gray-a6)",
        borderRadius: 6,
        backgroundColor: "var(--color-panel-translucent)",
        maxWidth: 680,
      }}
    >
      <Flex direction="column" gap="2">
        <Text size="1" color="gray">
          Enter this code:
        </Text>
        <Code
          size="6"
          weight="bold"
          style={{
            letterSpacing: "0.3em",
            paddingInline: 12,
            paddingBlock: 6,
            userSelect: "all",
            alignSelf: "flex-start",
          }}
        >
          {approval.userCode}
        </Code>
        <Text size="1" color="gray">
          at <InlineCode>{originForUrl(approval.verificationUri)}</InlineCode>
        </Text>
        <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
          The browser was opened to the verification page. The connection completes automatically
          once you approve there.
        </Text>
      </Flex>
    </Box>
  );
}

function DeviceCodeActions({ onCancel }: { onCancel: () => void }) {
  return (
    <Button onClick={onCancel} size="2" variant="soft" color="gray">
      Cancel
    </Button>
  );
}

function DeviceCodeDetails({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Service"
        value={<InlineCode>{approval.credentialLabel}</InlineCode>}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Verify at"
        value={<InlineCode>{approval.verificationUri}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Provider"
        value={<InlineCode>{originForUrl(approval.oauthTokenOrigin)}</InlineCode>}
      />
    </>
  );
}

function Detail({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <Flex
      align="start"
      gap="2"
      style={{
        minWidth: 0,
        color: "var(--gray-11)",
      }}
    >
      <Box style={{ display: "inline-flex", flexShrink: 0, paddingTop: 2 }}>{icon}</Box>
      <Text size="1" color="gray" style={{ width: 78, flexShrink: 0 }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0, flex: 1 }}>{value}</Box>
    </Flex>
  );
}

function ApprovalDetails({
  approval,
  caller,
  defaultOpen,
}: {
  approval: PendingApproval;
  caller: CallerInfo;
  defaultOpen: boolean;
}) {
  const detailsProps = defaultOpen ? { open: true } : {};
  return (
    <details className="approval-details" {...detailsProps}>
      <summary>
        <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
        Request details
      </summary>
      <Flex direction="column" gap="2" pt="2">
        <Detail
          icon={<PersonIcon />}
          label="Requester"
          value={
            <Flex align="center" gap="2" wrap="wrap">
              <InlineCode>
                {caller.kindLabel} · {caller.label}
              </InlineCode>
              <Tooltip content={`Full id — click to select: ${approval.callerId}`}>
                <Code
                  size="1"
                  variant="soft"
                  color="gray"
                  style={{ cursor: "text", userSelect: "all" }}
                >
                  {caller.shortId}
                </Code>
              </Tooltip>
            </Flex>
          }
        />
        <Detail
          icon={<GlobeIcon />}
          label="Repo"
          value={<InlineCode>{approval.repoPath}</InlineCode>}
        />
        <Detail
          icon={<LockClosedIcon />}
          label="Version"
          value={<IdCode value={approval.effectiveVersion} />}
        />
        {approval.kind === "credential" ? (
          <CredentialDetails approval={approval} />
        ) : approval.kind === "client-config" ? (
          <ClientConfigDetails approval={approval} />
        ) : approval.kind === "credential-input" ? (
          <CredentialInputDetails approval={approval} />
        ) : approval.kind === "userland" ? (
          <UserlandDetails approval={approval} />
        ) : approval.kind === "device-code" ? (
          <DeviceCodeDetails approval={approval} />
        ) : approval.kind === "unit-batch" ? (
          <UnitBatchDetails approval={approval} />
        ) : (
          <CapabilityDetails approval={approval} />
        )}
      </Flex>
    </details>
  );
}

function SecretConfigFields({
  approval,
  values,
  onChange,
}: {
  approval: PendingClientConfigApproval | PendingCredentialInputApproval;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <Flex direction="column" gap="2" pt="1" style={{ maxWidth: 620 }}>
      <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
        Secrets are entered in NatStack's shell UI, not exposed to panels or workers, and stored
        encrypted after submission.
      </Text>
      {approval.fields.map((field) => (
        <Flex key={field.name} direction="column" gap="1">
          <Flex align="center" gap="2" wrap="wrap">
            <Text size="1" weight="medium">
              {field.label}
            </Text>
            {field.required ? (
              <Badge color="amber" variant="soft">
                Required
              </Badge>
            ) : null}
            {field.type === "secret" ? (
              <Badge color="gray" variant="soft">
                Secret
              </Badge>
            ) : null}
          </Flex>
          <TextField.Root
            size="2"
            type={field.type === "secret" ? "password" : "text"}
            value={values[field.name] ?? ""}
            placeholder={field.label}
            onChange={(event) => onChange(field.name, event.currentTarget.value)}
          />
          {field.description ? (
            <Text size="1" color="gray">
              {field.description}
            </Text>
          ) : null}
        </Flex>
      ))}
    </Flex>
  );
}

function ClientConfigDetails({ approval }: { approval: PendingClientConfigApproval }) {
  const authorizeOrigin = originForUrl(approval.authorizeUrl);
  const tokenOrigin = originForUrl(approval.tokenUrl);
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Client"
        value={<IdCode value={approval.configId} />}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Authorize"
        value={
          <Code size="1" variant="soft" style={{ maxWidth: 520, overflowWrap: "anywhere" }}>
            {approval.authorizeUrl}
          </Code>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Token URL"
        value={
          <Code
            size="1"
            color="amber"
            variant="soft"
            style={{ maxWidth: 520, overflowWrap: "anywhere" }}
          >
            {approval.tokenUrl}
          </Code>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Binding"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            <Badge color="amber" variant="soft">
              Secret use limited to {tokenOrigin}
            </Badge>
            {authorizeOrigin !== tokenOrigin ? (
              <Badge color="gray" variant="outline">
                Sign-in starts at {authorizeOrigin}
              </Badge>
            ) : null}
          </Flex>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge
                key={field.name}
                color={field.type === "secret" ? "amber" : "gray"}
                variant="outline"
              >
                {field.name}
                {field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
    </>
  );
}

function CredentialInputDetails({ approval }: { approval: PendingCredentialInputApproval }) {
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Service"
        value={<InlineCode>{approval.credentialLabel}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Injects as"
        value={<InlineCode>{formatInjection(approval)}</InlineCode>}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Audience"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.audience.map((audience) => (
              <Code
                key={`${audience.match}:${audience.url}`}
                size="1"
                variant="soft"
                style={{ maxWidth: 360 }}
              >
                {audience.match ?? "origin"}: {audience.url}
              </Code>
            ))}
          </Flex>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge
                key={field.name}
                color={field.type === "secret" ? "amber" : "gray"}
                variant="outline"
              >
                {field.name}
                {field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
      {approval.scopes.length > 0 ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Scopes"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {approval.scopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
            </Flex>
          }
        />
      ) : null}
    </>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const oauthOrigins = [
    approval.oauthAuthorizeOrigin,
    approval.oauthTokenOrigin,
    approval.oauthUserinfoOrigin,
  ].filter((origin): origin is string => typeof origin === "string" && origin.length > 0);

  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Account"
        value={<InlineCode>{formatAccount(approval)}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Injects as"
        value={<InlineCode>{formatInjection(approval)}</InlineCode>}
      />
      {approval.gitOperation ? (
        <>
          <Detail
            icon={<LockClosedIcon />}
            label="Operation"
            value={<InlineCode>{approval.gitOperation.label}</InlineCode>}
          />
          <Detail
            icon={<GlobeIcon />}
            label="Remote"
            value={<InlineCode>{approval.gitOperation.remote}</InlineCode>}
          />
        </>
      ) : null}
      <Detail
        icon={<GlobeIcon />}
        label="Audience"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.audience.map((audience) => (
              <Code
                key={`${audience.match}:${audience.url}`}
                size="1"
                variant="soft"
                style={{ maxWidth: 360 }}
              >
                {audience.match ?? "origin"}: {audience.url}
              </Code>
            ))}
          </Flex>
        }
      />
      {oauthOrigins.length > 0 ? (
        <Detail
          icon={<GlobeIcon />}
          label="OAuth"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {oauthOrigins.map((origin) => (
                <Code
                  key={origin}
                  size="1"
                  color={approval.oauthAudienceDomainMismatch ? "red" : "gray"}
                  variant="soft"
                  style={{ maxWidth: 360 }}
                >
                  {origin}
                </Code>
              ))}
            </Flex>
          }
        />
      ) : null}
      {approval.oauthAudienceDomainMismatch ? (
        <Detail
          icon={<ExclamationTriangleIcon />}
          label="Warning"
          value={
            <Badge color="red" variant="soft">
              OAuth domain differs from audience
            </Badge>
          }
        />
      ) : null}
      {approval.scopes.length > 0 ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Scopes"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {approval.scopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
            </Flex>
          }
        />
      ) : null}
    </>
  );
}

function CapabilityDetails({ approval }: { approval: PendingCapabilityApproval }) {
  const detailRows = approval.details ?? [];
  return (
    <>
      {approval.resource ? (
        <Detail
          icon={<GlobeIcon />}
          label={approval.resource.label}
          value={<InlineCode>{approval.resource.value}</InlineCode>}
        />
      ) : null}
      {detailRows.map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<InlineCode>{detail.value}</InlineCode>}
        />
      ))}
    </>
  );
}

function UnitBatchDetails({ approval }: { approval: PendingUnitBatchApproval }) {
  return (
    <>
      {approval.configWrite ? (
        <Detail
          icon={<GearIcon />}
          label="Workspace config"
          value={
            <InlineCode>
              {approval.configWrite.repoPath} · {approval.configWrite.summary}
            </InlineCode>
          }
        />
      ) : null}
      {approval.units.length === 0 ? (
        <Text size="1" color="gray">
          No new units - this change only edits workspace configuration.
        </Text>
      ) : null}
      {approval.units.map((entry) => {
        const deps = Object.entries(entry.dependencyEvs ?? {});
        const external = Object.entries(entry.externalDeps ?? {});
        return (
          <details key={`${entry.unitKind}:${entry.unitName}`} className="approval-details">
            <summary>
              <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
              {entry.displayName}
              {entry.version ? ` · v${entry.version}` : ""}
            </summary>
            <Flex direction="column" gap="2" pt="2">
              <Detail
                icon={<ExclamationTriangleIcon />}
                label={entry.unitKind === "app" ? "App" : "Extension"}
                value={<InlineCode>{entry.unitName}</InlineCode>}
              />
              {entry.target ? (
                <Detail
                  icon={<GearIcon />}
                  label="Target"
                  value={<InlineCode>{entry.target}</InlineCode>}
                />
              ) : null}
              <Detail
                icon={<GlobeIcon />}
                label="Source"
                value={<InlineCode>{`${entry.source.repo}@${entry.source.ref}`}</InlineCode>}
              />
              {entry.ev ? (
                <Detail icon={<LockClosedIcon />} label="EV" value={<IdCode value={entry.ev} />} />
              ) : null}
              {entry.integrity ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="Integrity"
                  value={<IdCode value={entry.integrity} />}
                />
              ) : null}
              {entry.provider ? (
                <Detail
                  icon={<GearIcon />}
                  label="Provider"
                  value={
                    <InlineCode>{`${entry.provider.name}@${entry.provider.activeEv ?? "unknown"}`}</InlineCode>
                  }
                />
              ) : null}
              <Detail
                icon={<ExclamationTriangleIcon />}
                label="Access"
                value={
                  <Flex align="center" gap="1" wrap="wrap">
                    {entry.capabilities.map((capability) => (
                      <Badge key={capability} color="amber" variant="soft">
                        {capability}
                      </Badge>
                    ))}
                  </Flex>
                }
              />
              {deps.length > 0 ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="Deps"
                  value={
                    <Flex align="center" gap="1" wrap="wrap">
                      {deps.map(([name, ev]) => (
                        <Code key={name} size="1" variant="soft" style={{ maxWidth: 360 }}>
                          {name}: {truncateId(ev)}
                        </Code>
                      ))}
                    </Flex>
                  }
                />
              ) : null}
              {external.length > 0 ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="External"
                  value={
                    <Flex align="center" gap="1" wrap="wrap">
                      {external.map(([name, version]) => (
                        <Code key={name} size="1" variant="soft">
                          {name}@{version}
                        </Code>
                      ))}
                    </Flex>
                  }
                />
              ) : null}
            </Flex>
          </details>
        );
      })}
    </>
  );
}

function UserlandDetails({ approval }: { approval: PendingUserlandApproval }) {
  const issuer = approval.issuer;
  const showIssuer =
    issuer && (issuer.kind !== approval.callerKind || issuer.id !== approval.callerId);
  return (
    <>
      {showIssuer && issuer ? (
        <Detail
          icon={<PersonIcon />}
          label="Asked by"
          value={
            <Flex align="center" gap="2" wrap="wrap">
              <InlineCode>
                {issuer.kind} · {issuer.label ?? prettifyId(issuer.id)}
              </InlineCode>
              <Tooltip content={`Full id — click to select: ${issuer.id}`}>
                <Code
                  size="1"
                  variant="soft"
                  color="gray"
                  style={{ cursor: "text", userSelect: "all" }}
                >
                  {truncateId(issuer.id)}
                </Code>
              </Tooltip>
            </Flex>
          }
        />
      ) : null}
      <Detail
        icon={<LockClosedIcon />}
        label="Subject"
        value={<IdCode value={approval.subject.id} />}
      />
      {approval.subject.label ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Label"
          value={<InlineCode>{approval.subject.label}</InlineCode>}
        />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<InlineCode>{detail.value}</InlineCode>}
        />
      ))}
    </>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <Code size="1" variant="soft" style={{ maxWidth: "100%" }}>
      {children}
    </Code>
  );
}

function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function IdCode({ value, prefix }: { value: string; prefix?: string }) {
  const fullText = prefix ? `${prefix} ${value}` : value;
  const display = `${prefix ? `${prefix} ` : ""}${truncateId(value)}`;
  return (
    <Code size="1" variant="soft" title={fullText} style={{ maxWidth: "100%" }}>
      {display}
    </Code>
  );
}
