/**
 * ApprovalCard — the rich, presentational approval surface. It renders inside
 * the content-overlay (a separate document with NO RPC), so it is pure: it takes
 * the approval + derived caller as props and emits `ApprovalCardIntent`s up to
 * its host, which performs the actual `shellApproval.*` calls. Secret-input
 * values stay local and are only emitted on submit.
 */
import { useState } from "react";
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
  DragHandleDots2Icon,
  CrossCircledIcon,
  EnterIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  GearIcon,
  GlobeIcon,
  LockClosedIcon,
  MinusIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import type {
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingSecretInputApproval,
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
  getApprovalOperationKindLabel,
  getRequesterCategoryLabel,
  getStandardActionCopy,
  getUnitBatchActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "@natstack/shared/approvalCopy";
import type { ApprovalDecision } from "@natstack/shared/approvals";
import {
  approvalAccent,
  prettifyId,
  truncateId,
  type ApprovalCardIntentBody,
  type ApprovalCardIntent,
  type ApprovalQueueInfo,
  type CallerInfo,
} from "./approvalCardModel";

export interface ApprovalCardProps {
  approval: PendingApproval;
  caller: CallerInfo;
  /** Queue position for the navigator; null when a single approval is pending. */
  queue: ApprovalQueueInfo | null;
  decisionError: string | null;
  emit: (intent: ApprovalCardIntent) => void;
}

export function ApprovalCard({ approval, caller, queue, decisionError, emit }: ApprovalCardProps) {
  // Secret-config / credential-input values are held locally and only leave the
  // surface on submit.
  const [secretConfigValues, setSecretConfigValues] = useState<Record<string, string>>({});
  const emitForApproval = (intent: ApprovalCardIntentBody) => {
    emit({ ...intent, approvalId: approval.approvalId });
  };

  const copy = getApprovalCopy(approval);
  const attribution = getApprovalAttribution(approval);
  const accent = approvalAccent(approval);

  const actions =
    approval.kind === "client-config" ? (
      <ClientConfigActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({ type: "submit-client-config", values: secretConfigValues })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : approval.kind === "credential-input" ? (
      <CredentialInputActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({ type: "submit-credential-input", values: secretConfigValues })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : approval.kind === "userland" ? (
      <UserlandApprovalActions
        approval={approval}
        onChoose={(choice) => emitForApproval({ type: "resolve-userland", choice })}
      />
    ) : approval.kind === "device-code" ? (
      <DeviceCodeActions onCancel={() => emitForApproval({ type: "device-cancel" })} />
    ) : approval.kind === "unit-batch" ? (
      <UnitBatchActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
      />
    ) : approval.kind === "secret-input" ? (
      <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
        <DecisionButton
          label="Deny"
          description="Do not provide this input."
          color="red"
          icon={<CrossCircledIcon />}
          onClick={() => emitForApproval({ type: "decide", decision: "deny" })}
        />
        <Tooltip content="Dismiss">
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            onClick={() => emitForApproval({ type: "decide", decision: "dismiss" })}
          >
            <Cross2Icon />
          </IconButton>
        </Tooltip>
      </Flex>
    ) : (
      <StandardApprovalActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
      />
    );

  return (
    <div
      key={approval.approvalId}
      className="approval-card"
      data-approval-tone={accent}
      data-approval-card=""
      role="dialog"
      aria-modal="false"
      aria-label={copy.title}
    >
      <span key={approval.approvalId} className="approval-attention-pulse" aria-hidden="true" />
      <div className="approval-card-scroll">
        <Flex align="start" gap="3">
          <Box className="approval-icon-box" data-beacon="true">
            <ApprovalKindIcon approval={approval} size={18} />
          </Box>

          <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Text
                size="3"
                weight="bold"
                style={{ lineHeight: 1.25, color: "var(--gray-12)", overflowWrap: "anywhere" }}
              >
                {copy.title}
              </Text>
              {queue && queue.total > 1 ? (
                <QueueNavigator
                  index={queue.index}
                  total={queue.total}
                  canPrev={queue.canPrev}
                  canNext={queue.canNext}
                  onPrev={() => emitForApproval({ type: "browse", dir: "prev" })}
                  onNext={() => emitForApproval({ type: "browse", dir: "next" })}
                />
              ) : null}
            </Flex>

            <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
              <CallerChip caller={caller} onShow={() => emitForApproval({ type: "show-panel" })} />
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                {caller.kindLabel.toLowerCase()}
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

            {approval.kind === "credential" && approval.grantResource ? (
              <ApprovalGrantSummary approval={approval} />
            ) : null}

            {copy.warning ? (
              <Flex align="center" gap="1" style={{ color: "var(--red-11)" }}>
                <ExclamationTriangleIcon width={13} height={13} />
                <Text size="1" style={{ lineHeight: 1.35 }}>
                  {copy.warning}
                </Text>
              </Flex>
            ) : null}
            {decisionError ? (
              <Flex align="center" gap="1" style={{ color: "var(--red-11)" }}>
                <ExclamationTriangleIcon width={13} height={13} />
                <Text size="1" style={{ lineHeight: 1.35 }}>
                  Approval action failed: {decisionError}
                </Text>
              </Flex>
            ) : null}

            <ApprovalDetails
              approval={approval}
              caller={caller}
              defaultOpen={shouldOpenApprovalDetails(approval)}
            />
            {approval.kind === "device-code" ? <DeviceCodeBody approval={approval} /> : null}
            {approval.kind === "client-config" || approval.kind === "credential-input" ? (
              <SecretConfigFields
                approval={approval}
                values={secretConfigValues}
                onChange={(name, value) =>
                  setSecretConfigValues((previous) => ({ ...previous, [name]: value }))
                }
              />
            ) : null}
          </Flex>

          <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
            <Tooltip content="Drag to move">
              <span
                className="approval-drag-handle"
                data-overlay-drag-handle=""
                role="presentation"
                aria-hidden="true"
              >
                <DragHandleDots2Icon />
              </span>
            </Tooltip>
            <Tooltip content="Minimize to notifications">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                onClick={() => emitForApproval({ type: "minimize" })}
                aria-label="Minimize approval"
              >
                <MinusIcon />
              </IconButton>
            </Tooltip>
          </Flex>
        </Flex>
      </div>

      <div className="approval-card-footer">{actions}</div>
    </div>
  );
}

export function ApprovalKindIcon({
  approval,
  size = 18,
}: {
  approval: PendingApproval;
  size?: number;
}) {
  if (approval.kind === "unit-batch") return <ExclamationTriangleIcon width={size} height={size} />;
  if (approval.kind === "device-code") return <ExternalLinkIcon width={size} height={size} />;
  if (approval.kind === "capability") return <GlobeIcon width={size} height={size} />;
  if (approval.kind === "client-config" || approval.kind === "credential-input")
    return <GearIcon width={size} height={size} />;
  return <LockClosedIcon width={size} height={size} />;
}

function ApprovalGrantSummary({ approval }: { approval: PendingCredentialApproval }) {
  if (!approval.grantResource) return null;
  return (
    <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
      <Badge color="sky" variant="soft">
        {approval.bindingLabel ?? approval.grantResource.bindingId}
      </Badge>
      <Text size="1" color="gray" style={{ flexShrink: 0 }}>
        {approval.grantResource.action}
      </Text>
      <Code
        size="1"
        variant="soft"
        color="gray"
        style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
      >
        {approval.grantResource.resource}
      </Code>
    </Flex>
  );
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
        label={copy.repo.label}
        description={copy.repo.description}
        variant="surface"
        onClick={() => decide("repo")}
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
  decide: (decision: "once" | "session" | "deny" | "dismiss") => void;
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
  onChoose: (choice: string) => void;
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
          ? "Use the trust option to remember this approval."
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
    <Flex align="start" gap="2" style={{ minWidth: 0, color: "var(--gray-11)" }}>
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
        {approval.requester?.breadcrumbs && approval.requester.breadcrumbs.length > 1 ? (
          <Detail
            icon={<GearIcon />}
            label="Chain"
            value={<RequesterBreadcrumbs approval={approval} />}
          />
        ) : null}
        {approval.requester?.eval ? (
          <Detail
            icon={<GearIcon />}
            label="Eval"
            value={
              <Flex align="center" gap="1" wrap="wrap">
                {approval.requester.eval.ownerId ? (
                  <InlineCode>owner {approval.requester.eval.ownerId}</InlineCode>
                ) : null}
                {approval.requester.eval.subKey ? (
                  <InlineCode>scope {approval.requester.eval.subKey}</InlineCode>
                ) : null}
                {approval.requester.eval.runId ? (
                  <InlineCode>run {approval.requester.eval.runId}</InlineCode>
                ) : null}
              </Flex>
            }
          />
        ) : null}
        {approval.requester ? (
          <Detail
            icon={<LockClosedIcon />}
            label="Trust key"
            value={<IdCode value={approval.requester.stableIdentityKey} />}
          />
        ) : null}
        {approval.operation ? (
          <Detail
            icon={<GearIcon />}
            label="Operation"
            value={
              <Flex align="center" gap="1" wrap="wrap">
                <InlineCode>
                  {getApprovalOperationKindLabel(approval.operation.kind)} ·{" "}
                  {approval.operation.verb}
                </InlineCode>
                {approval.operation.object ? (
                  <InlineCode>{approval.operation.object.value}</InlineCode>
                ) : null}
              </Flex>
            }
          />
        ) : null}
        <Detail
          icon={<GlobeIcon />}
          label="Requester repo"
          value={<InlineCode>{approval.repoPath}</InlineCode>}
        />
        <Detail
          icon={<LockClosedIcon />}
          label="Requester version"
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
        ) : approval.kind === "secret-input" ? (
          <SecretInputDetails approval={approval} />
        ) : (
          <CapabilityDetails approval={approval} />
        )}
      </Flex>
    </details>
  );
}

function RequesterBreadcrumbs({ approval }: { approval: PendingApproval }) {
  const breadcrumbs = approval.requester?.breadcrumbs ?? [];
  return (
    <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
      {breadcrumbs.map((breadcrumb, index) => (
        <Flex key={`${breadcrumb.id}:${index}`} align="center" gap="1" style={{ minWidth: 0 }}>
          {index > 0 ? (
            <Text size="1" color="gray" style={{ flexShrink: 0 }}>
              &gt;
            </Text>
          ) : null}
          <Badge color="gray" variant="soft" style={{ maxWidth: 260 }}>
            {getRequesterCategoryLabel(breadcrumb.category)}
            {breadcrumb.label ? `: ${breadcrumb.label}` : ""}
          </Badge>
        </Flex>
      ))}
    </Flex>
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

function SecretInputDetails({ approval }: { approval: PendingSecretInputApproval }) {
  return (
    <>
      {approval.description ? (
        <Detail icon={<LockClosedIcon />} label="Request" value={approval.description} />
      ) : null}
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge key={field.name} color={field.type === "secret" ? "amber" : "gray"}>
                {field.label}
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
      {approval.bindingLabel ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Binding"
          value={<InlineCode>{approval.bindingLabel}</InlineCode>}
        />
      ) : null}
      {approval.grantResource ? (
        <Detail
          icon={<GlobeIcon />}
          label="Grant"
          value={
            <InlineCode>
              {approval.grantResource.bindingId} {approval.grantResource.action}{" "}
              {approval.grantResource.resource}
            </InlineCode>
          }
        />
      ) : null}
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

function IdCode({ value, prefix }: { value: string; prefix?: string }) {
  const fullText = prefix ? `${prefix} ${value}` : value;
  const display = `${prefix ? `${prefix} ` : ""}${truncateId(value)}`;
  return (
    <Code size="1" variant="soft" title={fullText} style={{ maxWidth: "100%" }}>
      {display}
    </Code>
  );
}
