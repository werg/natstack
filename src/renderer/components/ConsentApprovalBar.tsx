import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Box, Button, Code, Flex, IconButton, Separator, Text, Tooltip } from "@radix-ui/themes";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  GlobeIcon,
  LockClosedIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";
import { useShellEvent } from "../shell/useShellEvent";
import { shellApproval, view } from "../shell/client";

export function ConsentApprovalBar() {
  const [pending, setPending] = useState<PendingApproval[]>([]);

  useEffect(() => {
    let cancelled = false;
    void shellApproval
      .listPending()
      .then((list) => {
        if (!cancelled) setPending(list);
      })
      .catch((err: unknown) => console.warn("[ConsentApprovalBar] listPending failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useShellEvent(
    "shell-approval:pending-changed",
    useCallback((payload: { pending: PendingApproval[] }) => {
      setPending(payload.pending);
    }, []),
  );

  const current = pending[0] ?? null;

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
  const accountLabel = formatAccount(current);
  const injectionLabel = formatInjection(current);
  const extraCount = pending.length - 1;
  const visibleScopes = current.scopes.slice(0, 3);
  const hiddenScopeCount = Math.max(0, current.scopes.length - visibleScopes.length);

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
            <LockClosedIcon width={16} height={16} />
          </Flex>

          <Flex direction="column" gap="2" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap">
              <Text size="2" weight="medium">
                Credential access request
              </Text>
              <Badge color="amber" variant="soft">
                {current.providerDisplayName}
              </Badge>
              {extraCount > 0 ? (
                <Badge color="gray" variant="soft">
                  +{extraCount} queued
                </Badge>
              ) : null}
            </Flex>

            <Flex align="center" gap="2" wrap="wrap">
              <Detail icon={<PersonIcon />} label={`${callerLabel} ${current.callerId}`} />
              <Detail icon={<LockClosedIcon />} label={accountLabel} />
              <Detail icon={<GlobeIcon />} label={injectionLabel} />
            </Flex>

            <Flex align="center" gap="1" wrap="wrap">
              {current.providerAudience.map((audience) => (
                <Code key={audience} size="1" variant="soft" style={{ maxWidth: 360 }}>
                  {audience}
                </Code>
              ))}
              {visibleScopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
              {hiddenScopeCount > 0 ? (
                <Tooltip content={current.scopes.slice(visibleScopes.length).join(", ")}>
                  <Badge color="gray" variant="outline">+{hiddenScopeCount} scopes</Badge>
                </Tooltip>
              ) : null}
            </Flex>
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

function formatAccount(approval: PendingApproval): string {
  const identity = approval.accountIdentity;
  return identity.email
    ?? identity.username
    ?? identity.workspaceName
    ?? identity.providerUserId
    ?? approval.connectionId;
}

function formatInjection(approval: PendingApproval): string {
  const injection = approval.injection;
  if (injection.type === "query-param") {
    return `query ${injection.name}`;
  }
  return `header ${injection.name}`;
}
