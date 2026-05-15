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
  PendingCredentialInputApproval,
  PendingClientConfigApproval,
  PendingDeviceCodeApproval,
  PendingUserlandApproval,
} from "@natstack/shared/approvals";
import {
  formatAccount,
  formatInjection,
  getApprovalCategoryLabel,
  getApprovalCopy,
  getStandardActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "@natstack/shared/approvalCopy";
import { useShellEvent } from "../shell/useShellEvent";
import { shellApproval, shellPresence, view } from "../shell/client";

export function ConsentApprovalBar() {
  const [pendingAccess, setPendingAccess] = useState<PendingApproval[]>([]);
  const [secretConfigValues, setSecretConfigValues] = useState<Record<string, string>>({});

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
    setSecretConfigValues({});
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

  const callerLabel = current.callerKind === "worker" ? "Worker" : "Panel";
  const extraCount = pendingAccess.length - 1;
  const copy = getApprovalCopy(current, callerLabel);

  return (
    <Box
      ref={barRef}
      style={{
        // Panel surface beneath, flat alpha-sky tint layered on top.
        // The two-property form is needed because background-image draws over
        // background-color; using `background` shorthand would clobber one.
        backgroundColor: "var(--color-panel-solid)",
        backgroundImage: "linear-gradient(var(--sky-a3), var(--sky-a3))",
        borderBottom: "1px solid var(--gray-a6)",
        // Accent strip on top edge.
        boxShadow: ["inset 0 3px 0 0 var(--sky-9)", "0 4px 12px -4px var(--black-a6)"].join(", "),
        flexShrink: 0,
      }}
    >
      <Flex direction="column" gap="3" px="3" py="2">
        <Flex align="start" gap="3">
          <Flex
            align="center"
            justify="center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: "var(--sky-9)",
              color: "var(--sky-contrast)",
              flexShrink: 0,
            }}
          >
            {current.kind === "capability" || current.kind === "device-code" ? (
              <ExternalLinkIcon width={16} height={16} />
            ) : (
              <LockClosedIcon width={16} height={16} />
            )}
          </Flex>

          <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Text
                size="1"
                weight="bold"
                style={{
                  color: "var(--sky-11)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {getApprovalCategoryLabel(current)}
              </Text>
              <Text size="2" weight="bold">
                {copy.title}
              </Text>
              {current.kind === "credential" ? (
                <Badge color="gray" variant="soft" highContrast>
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
            {current.kind === "userland" ? <UserlandApprovalBody approval={current} /> : null}
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

        <Flex justify="end" wrap="wrap" gap="2">
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
          ) : (
            <StandardApprovalActions approval={current} decide={decide} />
          )}
        </Flex>
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
        color="sky"
        variant="solid"
        onClick={() => decide("session")}
      />
      <DecisionButton
        label={copy.version.label}
        description={copy.version.description}
        variant="surface"
        onClick={() => decide("version")}
      />
      <DecisionButton
        label={copy.repo.label}
        description={copy.repo.description}
        variant="surface"
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
        Remembered until revoked.
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
  color?: "red" | "sky";
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

function UserlandApprovalBody({ approval }: { approval: PendingUserlandApproval }) {
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
      <Flex direction="column" gap="1">
        <Text size="1" color="gray">
          From <IdCode value={approval.callerId} />
        </Text>
        <Flex direction="column" gap="1">
          <Text size="1" color="gray">
            Request
          </Text>
          <Text size="2" weight="medium" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
            {approval.title}
          </Text>
        </Flex>
        <Flex align="center" gap="2" wrap="wrap">
          <Text size="1" color="gray">
            Subject
          </Text>
          <IdCode value={approval.subject.id} />
          {approval.subject.label ? <InlineCode>{approval.subject.label}</InlineCode> : null}
        </Flex>
        {approval.warning ? (
          <Flex align="center" gap="1" style={{ color: "var(--red-11)" }}>
            <ExclamationTriangleIcon width={13} height={13} />
            <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {approval.warning}
            </Text>
          </Flex>
        ) : null}
        {approval.summary ? (
          <Text size="2" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
            {approval.summary}
          </Text>
        ) : null}
      </Flex>
    </Box>
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
          value={<IdCode prefix={callerLabel} value={approval.callerId} />}
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

function UserlandDetails({ approval }: { approval: PendingUserlandApproval }) {
  return (
    <>
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
