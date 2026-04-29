import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Box, Button, Code, Flex, IconButton, Separator, Text, Tooltip } from "@radix-ui/themes";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockClosedIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import type { ApprovalDecision, PendingApproval, PendingCapabilityApproval, PendingCredentialApproval } from "@natstack/shared/approvals";
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
    }, []),
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

  return (
    <Box
      ref={barRef}
      style={{
        background:
          "linear-gradient(180deg, var(--gray-1), var(--gray-2))",
        borderBottom: "1px solid var(--amber-7)",
        boxShadow: "0 1px 0 rgba(0, 0, 0, 0.03)",
        flexShrink: 0,
      }}
    >
      <Flex
        align={{ initial: "start", md: "center" }}
        justify="between"
        gap="3"
        px="3"
        py="2"
        wrap="wrap"
      >
        <Flex align="start" gap="3" style={{ minWidth: 280, flex: "1 1 520px" }}>
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
            {current.kind === "capability" ? <ExternalLinkIcon width={16} height={16} /> : <LockClosedIcon width={16} height={16} />}
          </Flex>

          <Flex direction="column" gap="2" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap">
              <Text size="2" weight="medium">
                {current.kind === "capability" ? current.title : "Credential access request"}
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

            <Flex align="center" gap="2" wrap="wrap">
              <Detail icon={<PersonIcon />} label={`${callerLabel} ${current.callerId}`} />
              {current.kind === "credential" ? (
                <>
                  <Detail icon={<LockClosedIcon />} label={formatAccount(current)} />
                  <Detail icon={<GlobeIcon />} label={formatInjection(current)} />
                </>
              ) : (
                <CapabilityDetails approval={current} />
              )}
            </Flex>

            {current.kind === "credential" ? <CredentialDetails approval={current} /> : null}
          </Flex>
        </Flex>

        <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
          <Button size="1" variant="solid" onClick={() => decide("session")}>
            <CheckCircledIcon />
            Session
          </Button>
          <Button size="1" variant="soft" onClick={() => decide("version")}>
            <CheckCircledIcon />
            Version
          </Button>
          <Button size="1" variant="soft" onClick={() => decide("repo")}>
            <CheckCircledIcon />
            Repo
          </Button>
          <Separator orientation="vertical" size="2" />
          <Button size="1" variant="soft" color="red" onClick={() => decide("deny")}>
            <CrossCircledIcon />
            Deny
          </Button>
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

function Detail({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <Flex
      align="center"
      gap="1"
      style={{
        minWidth: 0,
        color: "var(--gray-11)",
      }}
    >
      <Box style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</Box>
      <Text size="1" truncate style={{ maxWidth: 260 }}>
        {label}
      </Text>
    </Flex>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const detailItems = approval.scopes;
  const visibleScopes = detailItems.slice(0, 3);
  const hiddenScopeCount = Math.max(0, detailItems.length - visibleScopes.length);
  const oauthOrigins = [approval.oauthAuthorizeOrigin, approval.oauthTokenOrigin].filter(
    (origin): origin is string => typeof origin === "string" && origin.length > 0,
  );

  return (
    <Flex align="center" gap="1" wrap="wrap">
      {oauthOrigins.map((origin) => (
        <Code key={origin} size="1" color={approval.oauthAudienceDomainMismatch ? "red" : "gray"} variant="soft" style={{ maxWidth: 360 }}>
          OAuth {origin}
        </Code>
      ))}
      {approval.audience.map((audience) => (
        <Code key={`${audience.match}:${audience.url}`} size="1" variant="soft" style={{ maxWidth: 360 }}>
          {audience.url}
        </Code>
      ))}
      {approval.oauthAudienceDomainMismatch ? (
        <Tooltip content="OAuth authority and credential audience do not share the same base domain">
          <Badge color="red" variant="soft">Domain mismatch</Badge>
        </Tooltip>
      ) : null}
      {visibleScopes.map((scope) => (
        <Badge key={scope} color="gray" variant="outline">
          {scope}
        </Badge>
      ))}
      {hiddenScopeCount > 0 ? (
        <Tooltip content={detailItems.slice(visibleScopes.length).join(", ")}>
          <Badge color="gray" variant="outline">+{hiddenScopeCount} details</Badge>
        </Tooltip>
      ) : null}
    </Flex>
  );
}

function CapabilityDetails({ approval }: { approval: PendingCapabilityApproval }) {
  return (
    <>
      {approval.resource ? <Detail icon={<GlobeIcon />} label={`${approval.resource.label}: ${approval.resource.value}`} /> : null}
      {approval.details?.map((detail) => (
        <Detail key={detail.label} icon={<LockClosedIcon />} label={`${detail.label}: ${detail.value}`} />
      ))}
    </>
  );
}

function formatAccount(approval: PendingCredentialApproval): string {
  const identity = approval.accountIdentity;
  return identity.email
    ?? identity.username
    ?? identity.workspaceName
    ?? identity.providerUserId
    ?? approval.credentialId;
}

function formatInjection(approval: PendingCredentialApproval): string {
  const injection = approval.injection;
  if (injection.type === "query-param") {
    return `query ${injection.name}`;
  }
  return `header ${injection.name}`;
}
