import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  IconButton,
  Separator,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  GlobeIcon,
  IdCardIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  ReloadIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
import {
  credentials,
  panel,
  panelTree,
  type CredentialAccessGrantSummary,
  type CredentialAccessSubjectSummary,
  type ManagedCredentialSummary,
} from "@workspace/runtime";
import { mountAboutPanel, AboutPage, Section } from "@workspace/about-shared/ui";

type CredentialStatus = {
  label: string;
  color: "green" | "amber" | "red";
  icon: "active" | "warning" | "revoked";
};

function credentialStatus(credential: ManagedCredentialSummary): CredentialStatus {
  if (credential.revokedAt) return { label: "Revoked", color: "red", icon: "revoked" };
  if (credential.expiresAt && credential.expiresAt <= Date.now()) {
    return { label: "Expired", color: "amber", icon: "warning" };
  }
  return { label: "Active", color: "green", icon: "active" };
}

function StatusBadge({ status }: { status: CredentialStatus }) {
  const icon =
    status.icon === "active" ? (
      <CheckCircledIcon />
    ) : status.icon === "revoked" ? (
      <CrossCircledIcon />
    ) : (
      <ExclamationTriangleIcon />
    );
  return (
    <Badge color={status.color} variant="soft">
      {icon}
      {status.label}
    </Badge>
  );
}

function formatDate(timestamp?: number): string {
  if (!timestamp) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function accountLabel(credential: ManagedCredentialSummary): string {
  const account = credential.accountIdentity;
  return (
    account?.email ??
    account?.username ??
    account?.workspaceName ??
    account?.providerUserId ??
    "Unknown account"
  );
}

function ownerLabel(credential: ManagedCredentialSummary): string {
  const owner = credential.owner;
  if (!owner) return "Unknown owner";
  return `${owner.label} (${owner.sourceKind})`;
}

function bindingLabel(credential: ManagedCredentialSummary): string {
  const bindings = credential.bindings ?? [];
  if (bindings.length === 0) return "No bindings";
  return bindings
    .map((binding) => binding.label ?? `${binding.use}:${binding.id}`)
    .join(", ");
}

function audienceLabel(credential: ManagedCredentialSummary): string {
  const audience = credential.bindings?.flatMap((binding) => binding.audience) ?? credential.audience;
  const urls = [...new Set(audience.map((entry) => entry.url))];
  if (urls.length === 0) return "No audience";
  if (urls.length === 1) return urls[0]!;
  return `${urls[0]} and ${urls.length - 1} more`;
}

function injectionLabel(credential: ManagedCredentialSummary): string {
  const injection = credential.injection;
  switch (injection.type) {
    case "header":
      return `Header: ${injection.name}`;
    case "query-param":
      return `Query parameter: ${injection.name}`;
    case "basic-auth":
      return "Basic auth";
    case "oauth1-signature":
      return "OAuth 1 signature";
    case "cookie":
      return "Cookie";
    case "aws-sigv4":
      return `AWS SigV4: ${injection.service}/${injection.region}`;
    case "ssh-key":
      return "SSH key";
  }
}

function scopeLabel(grant: CredentialAccessGrantSummary): string {
  if (grant.scope === "caller") return grant.callerId ?? "Caller";
  if (grant.scope === "version") {
    return `${grant.repoPath ?? "Unknown repo"} @ ${grant.effectiveVersion ?? "unknown version"}`;
  }
  return grant.repoPath ?? "Repository";
}

function subjectLabel(subject: CredentialAccessSubjectSummary): string {
  return subject.title ?? subject.id;
}

function subjectDetail(subject: CredentialAccessSubjectSummary): string {
  const parts = [
    subject.source?.repoPath,
    subject.source?.effectiveVersion,
    subject.contextId ? `ctx:${subject.contextId}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : subject.id;
}

function useActionLabel(grant: CredentialAccessGrantSummary): string {
  return `${grant.use} / ${grant.action}`;
}

function matchesQuery(credential: ManagedCredentialSummary, query: string): boolean {
  const haystack = [
    credential.label,
    credential.id,
    accountLabel(credential),
    ownerLabel(credential),
    bindingLabel(credential),
    audienceLabel(credential),
    injectionLabel(credential),
    ...credential.grants.flatMap((grant) => [
      grant.resource,
      grant.scope,
      grant.repoPath,
      grant.effectiveVersion,
      grant.callerId,
      ...grant.subjects.flatMap((subject) => [
        subject.id,
        subject.title,
        subject.source?.repoPath,
        subject.focusPanelTitle,
      ]),
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Box
      p="3"
      style={{
        border: "1px solid var(--gray-6)",
        borderRadius: 8,
        background: "var(--gray-2)",
        minWidth: 0,
      }}
    >
      <Text size="6" weight="bold" as="div">
        {value}
      </Text>
      <Text size="1" color="gray">
        {label}
      </Text>
    </Box>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
      <Text size="1" color="gray">
        {label}
      </Text>
      <Text size="2" style={{ wordBreak: "break-word" }}>
        {value}
      </Text>
    </Flex>
  );
}

function KindBadge({ subject }: { subject: CredentialAccessSubjectSummary }) {
  const color =
    subject.kind === "panel"
      ? "blue"
      : subject.kind === "worker"
        ? "green"
        : subject.kind === "do"
          ? "orange"
          : "gray";
  return (
    <Badge color={color} variant="soft">
      {subject.kind}
    </Badge>
  );
}

function SubjectRow({
  subject,
  onFocus,
}: {
  subject: CredentialAccessSubjectSummary;
  onFocus: (subject: CredentialAccessSubjectSummary) => void;
}) {
  const focusLabel = subject.kind === "panel" ? "Focus panel" : "Focus parent";
  return (
    <Flex
      align="center"
      justify="between"
      gap="3"
      py="2"
      style={{ borderTop: "1px solid var(--gray-5)" }}
    >
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <KindBadge subject={subject} />
        <Box style={{ minWidth: 0 }}>
          <Text size="2" weight="medium" style={{ wordBreak: "break-word" }}>
            {subjectLabel(subject)}
          </Text>
          <Text as="div" size="1" color="gray" style={{ wordBreak: "break-word" }}>
            {subjectDetail(subject)}
          </Text>
        </Box>
      </Flex>
      {subject.focusPanelId ? (
        <Button size="1" variant="soft" onClick={() => onFocus(subject)}>
          <ExternalLinkIcon />
          {focusLabel}
        </Button>
      ) : (
        <Text size="1" color="gray" style={{ textAlign: "right" }}>
          {subject.focusUnavailableReason ?? "Focus unavailable"}
        </Text>
      )}
    </Flex>
  );
}

function GrantRow({
  grant,
  expanded,
  onToggle,
  onFocusSubject,
}: {
  grant: CredentialAccessGrantSummary;
  expanded: boolean;
  onToggle: () => void;
  onFocusSubject: (subject: CredentialAccessSubjectSummary) => void;
}) {
  return (
    <Box
      style={{
        border: "1px solid var(--gray-6)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          border: 0,
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          padding: "10px 12px",
          textAlign: "left",
        }}
      >
        <Flex align="center" justify="between" gap="3">
          <Flex align="center" gap="2" style={{ minWidth: 0 }}>
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <Box style={{ minWidth: 0 }}>
              <Text size="2" weight="medium">
                {scopeLabel(grant)}
              </Text>
              <Text as="div" size="1" color="gray" style={{ wordBreak: "break-word" }}>
                {useActionLabel(grant)} / {grant.resource}
              </Text>
            </Box>
          </Flex>
          <Badge variant="outline">{grant.subjects.length}</Badge>
        </Flex>
      </button>
      {expanded && (
        <Box px="3" pb="3">
          <Grid columns={{ initial: "1", sm: "2" }} gap="3" pb="2">
            <DetailLine label="Binding" value={grant.bindingLabel ?? grant.bindingId} />
            <DetailLine label="Granted" value={`${formatDate(grant.grantedAt)} by ${grant.grantedBy}`} />
          </Grid>
          {grant.subjects.length > 0 ? (
            <Box>
              {grant.subjects.map((subject) => (
                <SubjectRow key={subject.id} subject={subject} onFocus={onFocusSubject} />
              ))}
            </Box>
          ) : (
            <Text size="2" color="gray">
              No active panels, workers, or durable objects match this grant.
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function CredentialSection({
  credential,
  expanded,
  expandedGrants,
  onToggleCredential,
  onToggleGrant,
  onFocusSubject,
  onRevoke,
}: {
  credential: ManagedCredentialSummary;
  expanded: boolean;
  expandedGrants: Set<string>;
  onToggleCredential: () => void;
  onToggleGrant: (grantId: string) => void;
  onFocusSubject: (subject: CredentialAccessSubjectSummary) => void;
  onRevoke: () => void;
}) {
  const status = credentialStatus(credential);
  const isRevoked = Boolean(credential.revokedAt);
  return (
    <Section>
      <Flex align="start" justify="between" gap="3">
        <Flex align="start" gap="3" style={{ minWidth: 0 }}>
          <Box
            style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              color: "var(--accent-11)",
              background: "var(--accent-3)",
              flexShrink: 0,
            }}
          >
            <IdCardIcon />
          </Box>
          <Box style={{ minWidth: 0 }}>
            <Flex align="center" gap="2" wrap="wrap">
              <Heading size="4" style={{ wordBreak: "break-word" }}>
                {credential.label}
              </Heading>
              <StatusBadge status={status} />
            </Flex>
            <Text size="2" color="gray" style={{ wordBreak: "break-word" }}>
              {accountLabel(credential)}
            </Text>
          </Box>
        </Flex>
        <Flex align="center" gap="2" wrap="wrap" justify="end">
          <Button size="2" variant="soft" onClick={onToggleCredential}>
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            Grants
          </Button>
          <Button size="2" variant="soft" color="red" onClick={onRevoke} disabled={isRevoked}>
            <TrashIcon />
            Revoke
          </Button>
        </Flex>
      </Flex>

      <Grid columns={{ initial: "1", sm: "2" }} gap="3" mt="4">
        <DetailLine label="Owner" value={ownerLabel(credential)} />
        <DetailLine label="Bindings" value={bindingLabel(credential)} />
        <DetailLine label="Audience" value={audienceLabel(credential)} />
        <DetailLine label="Injection" value={injectionLabel(credential)} />
        <DetailLine label="Expires" value={credential.expiresAt ? formatDate(credential.expiresAt) : "Never"} />
        <DetailLine label="Scopes" value={credential.scopes.length ? credential.scopes.join(", ") : "None"} />
      </Grid>

      {expanded && (
        <>
          <Separator size="4" my="4" />
          <Flex direction="column" gap="2">
            {credential.grants.length > 0 ? (
              credential.grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  expanded={expandedGrants.has(grant.id)}
                  onToggle={() => onToggleGrant(grant.id)}
                  onFocusSubject={onFocusSubject}
                />
              ))
            ) : (
              <Text size="2" color="gray">
                No persistent grants are stored for this credential.
              </Text>
            )}
          </Flex>
        </>
      )}
    </Section>
  );
}

function CredentialsPage() {
  const isMobile = useIsMobile();
  const [items, setItems] = useState<ManagedCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [expandedCredentials, setExpandedCredentials] = useState<Set<string>>(new Set());
  const [expandedGrants, setExpandedGrants] = useState<Set<string>>(new Set());
  const [pendingRevoke, setPendingRevoke] = useState<ManagedCredentialSummary | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await credentials.inspectStoredCredentials());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return panel.onFocus(() => void load());
  }, [load]);

  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((credential) => matchesQuery(credential, query));
  }, [items, filter]);

  const metrics = useMemo(() => {
    const active = items.filter((item) => credentialStatus(item).label === "Active").length;
    const grantCount = items.reduce((total, item) => total + item.grants.length, 0);
    const subjects = new Set(
      items.flatMap((item) => item.grants.flatMap((grant) => grant.subjects.map((subject) => subject.id)))
    );
    return { active, grantCount, subjectCount: subjects.size };
  }, [items]);

  const toggleCredential = useCallback((credentialId: string) => {
    setExpandedCredentials((current) => {
      const next = new Set(current);
      if (next.has(credentialId)) next.delete(credentialId);
      else next.add(credentialId);
      return next;
    });
  }, []);

  const toggleGrant = useCallback((grantId: string) => {
    setExpandedGrants((current) => {
      const next = new Set(current);
      if (next.has(grantId)) next.delete(grantId);
      else next.add(grantId);
      return next;
    });
  }, []);

  const focusSubject = useCallback(async (subject: CredentialAccessSubjectSummary) => {
    if (!subject.focusPanelId) return;
    try {
      await panelTree.get(subject.focusPanelId).focus();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const revokePending = useCallback(async () => {
    if (!pendingRevoke) return;
    setRevokingId(pendingRevoke.id);
    try {
      await credentials.revokeCredential(pendingRevoke.id);
      setPendingRevoke(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  }, [load, pendingRevoke]);

  return (
    <>
      <AboutPage
        icon={<LockClosedIcon width={20} height={20} />}
        title="Credentials"
        subtitle="Stored credential access, grants, and active runtime usage"
        maxWidth={980}
        actions={
          <Tooltip content="Refresh">
            <IconButton variant="soft" onClick={() => void load()} disabled={loading} aria-label="Refresh">
              {loading ? <Spinner /> : <ReloadIcon />}
            </IconButton>
          </Tooltip>
        }
      >
        <Section>
          <Flex direction="column" gap="4">
            <Grid columns={{ initial: "1", sm: "3" }} gap="3">
              <Metric label="Stored" value={items.length} />
              <Metric label="Active" value={metrics.active} />
              <Metric label="Granted runtimes" value={metrics.subjectCount} />
            </Grid>
            <Flex align="center" gap="3" direction={isMobile ? "column" : "row"}>
              <TextField.Root
                size="3"
                placeholder="Filter credentials..."
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                style={{ width: "100%" }}
              >
                <TextField.Slot>
                  <MagnifyingGlassIcon />
                </TextField.Slot>
              </TextField.Root>
              <Badge variant="outline">
                <GlobeIcon />
                {metrics.grantCount} grants
              </Badge>
            </Flex>
          </Flex>
        </Section>

        {error && (
          <Section>
            <Flex align="center" justify="between" gap="3">
              <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                <ExclamationTriangleIcon style={{ color: "var(--red-9)" }} />
                <Text size="2" color="red" style={{ wordBreak: "break-word" }}>
                  {error}
                </Text>
              </Flex>
              <Button size="2" variant="soft" onClick={() => void load()}>
                Retry
              </Button>
            </Flex>
          </Section>
        )}

        {loading && items.length === 0 ? (
          <Flex align="center" justify="center" gap="2" py="6">
            <Spinner />
            <Text color="gray">Loading credentials...</Text>
          </Flex>
        ) : visibleItems.length > 0 ? (
          visibleItems.map((credential) => (
            <CredentialSection
              key={credential.id}
              credential={credential}
              expanded={expandedCredentials.has(credential.id)}
              expandedGrants={expandedGrants}
              onToggleCredential={() => toggleCredential(credential.id)}
              onToggleGrant={toggleGrant}
              onFocusSubject={(subject) => void focusSubject(subject)}
              onRevoke={() => setPendingRevoke(credential)}
            />
          ))
        ) : (
          <Section>
            <Text size="2" color="gray">
              {items.length === 0 ? "No stored credentials." : "No credentials match the current filter."}
            </Text>
          </Section>
        )}
      </AboutPage>

      <AlertDialog.Root open={Boolean(pendingRevoke)} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <AlertDialog.Content maxWidth="450px">
          <AlertDialog.Title>Revoke credential</AlertDialog.Title>
          <AlertDialog.Description size="2">
            {pendingRevoke
              ? `Revoke ${pendingRevoke.label}? Active panels and workers will lose access after this credential is revoked.`
              : ""}
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray" disabled={Boolean(revokingId)}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={() => void revokePending()} disabled={Boolean(revokingId)}>
                {revokingId ? <Spinner /> : <TrashIcon />}
                Revoke
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

mountAboutPanel(CredentialsPage);
