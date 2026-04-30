import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Badge, Box, Button, Code, Flex, IconButton, Text, TextField, Tooltip } from "@radix-ui/themes";
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
  PendingOAuthClientConfigApproval,
} from "@natstack/shared/approvals";
import { useShellEvent } from "../shell/useShellEvent";
import { shellApproval, view } from "../shell/client";

export function ConsentApprovalBar() {
  const [pendingAccess, setPendingAccess] = useState<PendingApproval[]>([]);
  const [oauthClientConfigValues, setOAuthClientConfigValues] = useState<Record<string, string>>({});

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

  useEffect(() => {
    setOAuthClientConfigValues({});
  }, [current?.approvalId]);

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
  const submitOAuthClientConfig = () => {
    if (current?.kind !== "oauth-client-config") return;
    void shellApproval
      .submitOAuthClientConfig(current.approvalId, oauthClientConfigValues)
      .catch((err: unknown) => console.error("[ConsentApprovalBar] submitOAuthClientConfig failed:", err));
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
                {getApprovalCategoryLabel(current)}
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
            {current.kind === "oauth-client-config" ? (
              <OAuthClientConfigFields
                approval={current}
                values={oauthClientConfigValues}
                onChange={(name, value) =>
                  setOAuthClientConfigValues((previous) => ({ ...previous, [name]: value }))
                }
              />
            ) : null}
          </Flex>
        </Flex>

        {current.kind === "oauth-client-config" ? (
          <OAuthClientConfigActions
            approval={current}
            values={oauthClientConfigValues}
            onSubmit={submitOAuthClientConfig}
            onDeny={() => decide("deny")}
            onDismiss={() => decide("dismiss")}
          />
        ) : (
          <StandardApprovalActions approval={current} decide={decide} />
        )}
      </Flex>
    </Box>
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
  return (
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
        label={copy.once.label}
        description={copy.once.description}
        variant="solid"
        onClick={() => decide("once")}
      />
      <DecisionButton
        label={copy.session.label}
        description={copy.session.description}
        onClick={() => decide("session")}
      />
      <DecisionButton
        label={copy.version.label}
        description={copy.version.description}
        onClick={() => decide("version")}
      />
      <DecisionButton
        label={copy.repo.label}
        description={copy.repo.description}
        onClick={() => decide("repo")}
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

function OAuthClientConfigActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss,
}: {
  approval: PendingOAuthClientConfigApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some((field) => field.required && !values[field.name]?.trim());
  return (
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
      <Tooltip content={missingRequired ? "Enter the required fields first." : "Save this connected service."}>
        <Button size="1" variant="solid" disabled={missingRequired} onClick={onSubmit}>
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
        ) : approval.kind === "oauth-client-config" ? (
          <OAuthClientConfigDetails approval={approval} />
        ) : (
          <CapabilityDetails approval={approval} />
        )}
      </Flex>
    </details>
  );
}

function OAuthClientConfigFields({
  approval,
  values,
  onChange,
}: {
  approval: PendingOAuthClientConfigApproval;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <Flex direction="column" gap="2" pt="1" style={{ maxWidth: 620 }}>
      <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
        Secret fields are stored encrypted and only used when connecting to this service.
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

function OAuthClientConfigDetails({ approval }: { approval: PendingOAuthClientConfigApproval }) {
  const authorizeOrigin = originForUrl(approval.authorizeUrl);
  const tokenOrigin = originForUrl(approval.tokenUrl);
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Client"
        value={<InlineCode>{approval.configId}</InlineCode>}
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
          <Code size="1" color="amber" variant="soft" style={{ maxWidth: 520, overflowWrap: "anywhere" }}>
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
              <Badge key={field.name} color={field.type === "secret" ? "amber" : "gray"} variant="outline">
                {field.name}{field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
    </>
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

function getApprovalCategoryLabel(approval: PendingApproval): string {
  if (approval.kind === "credential") {
    return "Access request";
  }
  if (approval.kind === "oauth-client-config") {
    return "Service setup";
  }
  if (approval.capability === "internal-git-write") {
    return "Write request";
  }
  return isOAuthExternalApproval(approval) ? "Sign-in action" : "Browser action";
}

function getStandardActionCopy(approval: PendingCredentialApproval | PendingCapabilityApproval): {
  once: { label: string; description: string };
  session: { label: string; description: string };
  version: { label: string; description: string };
  repo: { label: string; description: string };
  denyDescription: string;
} {
  if (approval.kind === "credential") {
    return {
      once: { label: "Use once", description: "Use this service for this request only." },
      session: { label: "Use this session", description: "Reuse this service until NatStack restarts." },
      version: { label: "Trust version", description: "Reuse this service for this exact code version." },
      repo: { label: "Trust repo", description: "Reuse this service for this workspace." },
      denyDescription: "Do not use this service.",
    };
  }
  if (isOAuthExternalApproval(approval)) {
    return {
      once: { label: "Connect once", description: "Open this sign-in flow once." },
      session: { label: "Connect this session", description: "Allow this sign-in origin until NatStack restarts." },
      version: { label: "Trust version", description: "Allow this sign-in origin for this exact code version." },
      repo: { label: "Trust repo", description: "Allow this sign-in origin for this workspace." },
      denyDescription: "Do not open this sign-in flow.",
    };
  }
  if (approval.capability === "internal-git-write") {
    return {
      once: { label: "Write once", description: "Allow this git write once." },
      session: { label: "Write this session", description: "Allow writes to this repository until NatStack restarts." },
      version: { label: "Trust version", description: "Allow this code version to write to this repository." },
      repo: { label: "Trust repo", description: "Allow this workspace project to write to this repository." },
      denyDescription: "Do not allow this git write.",
    };
  }
  return {
    once: { label: "Open once", description: "Open this browser action once." },
    session: { label: "Open this session", description: "Allow this browser origin until NatStack restarts." },
    version: { label: "Trust version", description: "Allow this browser origin for this exact code version." },
    repo: { label: "Trust repo", description: "Allow this browser origin for this workspace." },
    denyDescription: "Do not open this site.",
  };
}

function getApprovalCopy(
  approval: PendingApproval,
  callerLabel: string
): { title: string; summary: string; warning?: string } {
  const requester = `${callerLabel} ${approval.callerId}`;
  if (approval.kind === "capability") {
    if (approval.capability === "internal-git-write") {
      const destination = approval.resource?.value ?? "this repository";
      return {
        title: "Write project files",
        summary: `${requester} wants to push changes to ${destination}.`,
      };
    }
    const isOAuth = isOAuthExternalApproval(approval);
    const destination = formatCapabilityDestination(approval, isOAuth);
    if (isOAuth) {
      return {
        title: "Connect to service",
        summary: `${requester} wants to connect to ${destination} in your browser.`,
      };
    }
    return {
      title: "Open external site",
      summary: `${requester} wants to open ${destination} in your system browser.`,
    };
  }
  if (approval.kind === "oauth-client-config") {
    return {
      title: "Add service",
      summary: `${requester} wants to add ${formatServiceName(approval.configId)} as a connected service. Secrets stay encrypted and are only sent to ${formatUrlForSummary(approval.tokenUrl, "origin")}.`,
    };
  }

  const audience = formatAudienceSummary(approval);
  return {
    title: "Use connected service",
    summary: `${requester} wants to use ${approval.credentialLabel} with ${audience}.`,
    warning: approval.oauthAudienceDomainMismatch
      ? "The sign-in domain differs from the service domain."
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
  void approval;
  return false;
}

function originForUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function formatAudienceSummary(approval: PendingCredentialApproval): string {
  if (approval.audience.length === 0) return "an unspecified audience";
  const first = approval.audience[0];
  if (!first) return "an unspecified audience";
  const audience = formatUrlForSummary(first.url, first.match === "origin" ? "origin" : "path");
  const extraCount = approval.audience.length - 1;
  return extraCount > 0 ? `${audience} and ${extraCount} more` : audience;
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

function isOAuthExternalApproval(approval: PendingCapabilityApproval): boolean {
  return approval.details?.some((detail) => detail.label.toLowerCase() === "oauth callback") === true;
}

function formatCapabilityDestination(approval: PendingCapabilityApproval, oauth: boolean): string {
  const rawDestination = getCapabilityPrimaryDestination(approval);
  return formatUrlForSummary(rawDestination, oauth ? "origin" : "path");
}

function formatUrlForSummary(raw: string, mode: "origin" | "path" = "path"): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "mailto:") {
      return "email";
    }
    const host = url.hostname;
    if (mode === "origin") {
      return host;
    }
    const path = compactPath(url.pathname);
    return path ? `${host}${path}` : host;
  } catch {
    return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
  }
}

function compactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  const first = segments[0] ?? "";
  if (!first || first.length > 32) {
    return "";
  }
  return `/${first}${segments.length > 1 ? "/..." : ""}`;
}

function formatServiceName(configId: string): string {
  return configId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "this service";
}
