import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Badge, Box, Button, Code, Flex, IconButton, Text, Tooltip } from "@radix-ui/themes";
import {
  ChevronDownIcon,
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockClosedIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import type {
  ApprovalDecision,
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
} from "@natstack/shared/approvals";
import { useShellEvent } from "../shell/useShellEvent";
import { shellApproval, view } from "../shell/client";

export function ConsentApprovalBar() {
  const [pendingAccess, setPendingAccess] = useState<PendingApproval[]>([]);

  useEffect(() => {
    let cancelled = false;
    void shellApproval
      .listPending()
      .then((list) => {
        if (!cancelled) setPendingAccess(list);
      })
      .catch((err: unknown) => console.warn("[ConsentApprovalBar] listPending failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useShellEvent(
    "shell-approval:pending-changed",
    useCallback((payload: { pending: PendingApproval[] }) => {
      setPendingAccess(payload.pending);
    }, [])
  );

  const current = pendingAccess[0] ?? null;

  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!current) {
      void view.updateLayout({ consentBarHeight: 0 });
      return;
    }
    const el = barRef.current;
    const update = () => void view.updateLayout({ consentBarHeight: el?.offsetHeight ?? 0 });
    update();
    const observer = el ? new ResizeObserver(update) : null;
    if (el) observer?.observe(el);
    return () => {
      observer?.disconnect();
      void view.updateLayout({ consentBarHeight: 0 });
    };
  }, [current]);

  if (!current) return null;

  const decide = (decision: ApprovalDecision) => {
    void shellApproval
      .resolve(current.approvalId, decision)
      .catch((err: unknown) => console.error("[ConsentApprovalBar] resolve failed:", err));
  };

  const callerLabel = current.callerKind === "worker" ? "Worker" : "Panel";
  const extraCount = pendingAccess.length - 1;
  const copy = getApprovalCopy(current, callerLabel);

  return (
    <Box
      ref={barRef}
      style={{
        background: "linear-gradient(180deg, var(--gray-1), var(--gray-2))",
        borderBottom: "1px solid var(--amber-7)",
        boxShadow: "0 1px 0 rgba(0, 0, 0, 0.03)",
        flexShrink: 0,
      }}
    >
      <Flex align="start" justify="between" gap="3" px="3" py="2" wrap="wrap">
        <Flex align="start" gap="3" style={{ minWidth: 280, flex: "1 1 560px" }}>
          <Flex
            align="center"
            justify="center"
            style={{
              width: 30,
              height: 30,
              borderRadius: 6,
              backgroundColor: "var(--amber-4)",
              color: "var(--amber-11)",
              border: "1px solid var(--amber-7)",
              flexShrink: 0,
            }}
          >
            {current.kind === "capability" ? (
              <ExternalLinkIcon width={16} height={16} />
            ) : (
              <LockClosedIcon width={16} height={16} />
            )}
          </Flex>

          <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Badge color="amber" variant="soft">
                Approval needed
              </Badge>
              <Text size="2" weight="medium">
                {copy.title}
              </Text>
              {current.kind === "credential" ? (
                <Badge color="amber" variant="soft">
                  {current.credentialLabel}
                </Badge>
              ) : null}
              {extraCount > 0 ? (
                <Badge color="gray" variant="soft">
                  +{extraCount} queued
                </Badge>
              ) : null}
            </Flex>

            <Text size="2" color="gray" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {copy.summary}
            </Text>

            {copy.warning ? (
              <Flex align="center" gap="1" style={{ color: "var(--red-11)" }}>
                <ExclamationTriangleIcon width={13} height={13} />
                <Text size="1" style={{ lineHeight: 1.35 }}>
                  {copy.warning}
                </Text>
              </Flex>
            ) : null}

            <ApprovalDetails
              approval={current}
              callerLabel={callerLabel}
              defaultOpen={shouldOpenApprovalDetails(current)}
            />
          </Flex>
        </Flex>

        <Flex
          align="center"
          className="approval-actions"
          gap="2"
          wrap="wrap"
          style={{
            alignSelf: "flex-end",
            flexShrink: 0,
            justifyContent: "flex-start",
            marginLeft: "auto",
          }}
        >
          <DecisionButton
            label="Allow session"
            description="Temporary; clears when NatStack restarts."
            variant="solid"
            onClick={() => decide("session")}
          />
          <DecisionButton
            label="Trust version"
            description="Reuse for this exact code version."
            onClick={() => decide("version")}
          />
          <DecisionButton
            label="Trust repo"
            description="Reuse for this workspace."
            onClick={() => decide("repo")}
          />
          <DecisionButton
            label="Deny"
            description="Do not grant this request."
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
      </Flex>
    </Box>
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
  color?: "red";
  variant?: "solid" | "soft";
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
  callerLabel,
  defaultOpen,
}: {
  approval: PendingApproval;
  callerLabel: string;
  defaultOpen: boolean;
}) {
  return (
    <details className="approval-details" open={defaultOpen}>
      <summary>
        <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
        Request details
      </summary>
      <Flex direction="column" gap="2" pt="2">
        <Detail
          icon={<PersonIcon />}
          label="Requester"
          value={
            <InlineCode>
              {callerLabel} {approval.callerId}
            </InlineCode>
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
          value={<InlineCode>{approval.effectiveVersion}</InlineCode>}
        />
        {approval.kind === "credential" ? (
          <CredentialDetails approval={approval} />
        ) : (
          <CapabilityDetails approval={approval} />
        )}
      </Flex>
    </details>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const oauthOrigins = [approval.oauthAuthorizeOrigin, approval.oauthTokenOrigin].filter(
    (origin): origin is string => typeof origin === "string" && origin.length > 0
  );

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

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <Code size="1" variant="soft" style={{ maxWidth: "100%" }}>
      {children}
    </Code>
  );
}

function getApprovalCopy(
  approval: PendingApproval,
  callerLabel: string
): { title: string; summary: string; warning?: string } {
  const requester = `${callerLabel} ${approval.callerId}`;
  if (approval.kind === "capability") {
    const destination = getCapabilityPrimaryDestination(approval);
    return {
      title: approval.title,
      summary: `${requester} wants to open ${destination} in your system browser.`,
    };
  }

  const audience = formatAudienceSummary(approval);
  return {
    title: "Use stored credential",
    summary: `${requester} wants to use ${approval.credentialLabel} for ${audience}.`,
    warning: approval.oauthAudienceDomainMismatch
      ? "Check the details first: the OAuth provider domain does not match the credential audience."
      : undefined,
  };
}

function getCapabilityPrimaryDestination(approval: PendingCapabilityApproval): string {
  return (
    approval.details?.find((detail) => detail.label.toLowerCase() === "url")?.value ??
    approval.resource?.value ??
    "an external destination"
  );
}

function shouldOpenApprovalDetails(approval: PendingApproval): boolean {
  if (approval.kind === "credential") {
    return approval.oauthAudienceDomainMismatch === true;
  }
  return approval.details?.some((detail) => detail.label.toLowerCase() === "oauth callback") === true;
}

function formatAudienceSummary(approval: PendingCredentialApproval): string {
  if (approval.audience.length === 0) return "an unspecified audience";
  const first = approval.audience[0];
  if (!first) return "an unspecified audience";
  let origin = first.url;
  try {
    origin = new URL(first.url).origin;
  } catch {
    // Keep the original URL if it is not parseable in the renderer.
  }
  const extraCount = approval.audience.length - 1;
  return extraCount > 0 ? `${origin} and ${extraCount} more` : origin;
}

function formatAccount(approval: PendingCredentialApproval): string {
  const identity = approval.accountIdentity;
  return (
    identity.email ??
    identity.username ??
    identity.workspaceName ??
    identity.providerUserId ??
    approval.credentialId
  );
}

function formatInjection(approval: PendingCredentialApproval): string {
  const injection = approval.injection;
  if (injection.type === "query-param") {
    return `query ${injection.name}`;
  }
  return `header ${injection.name}`;
}
