import { Badge, Box, Button, Callout, Checkbox, Flex, Separator, Text, TextField } from "@radix-ui/themes";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EnvelopeClosedIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  Pencil1Icon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { useState } from "react";

import type {
  GmailAttentionAction,
  GmailAttentionCondition,
  GmailAttentionDirective,
  GmailAttentionMatcher,
  GmailAttentionScope,
  GmailInboxCardState,
  GmailThreadCardState as SharedGmailThreadCardState,
} from "@workspace/gmail/card-types";

type GmailThreadCardState = Partial<SharedGmailThreadCardState> & { threadId: string };

type GmailInboxState = Partial<Omit<GmailInboxCardState, "actionable" | "searchResults">> & {
  unread: number;
  actionable?: GmailThreadCardState[];
  searchResults?: GmailThreadCardState[];
};

interface GmailChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
  channelId: string;
  rpc: {
    call: <T = unknown>(targetId: string, method: string, args: unknown[]) => Promise<T>;
  };
}

const WATCH_PRESETS = [
  "People I have replied to",
  "Invoices and receipts",
  "Scheduling and calendar changes",
  "Urgent operational mail",
  "Messages with attachments",
  "Every email",
  "Quiet mode",
];

export function Pill({ state }: { state: GmailInboxState }) {
  const count = state.actionable?.length ?? 0;
  return (
    <Flex align="center" gap="1">
      <EnvelopeClosedIcon />
      <Text size="1" weight="medium">Gmail</Text>
      <Text size="1" color="gray">{state.unread} unread</Text>
      {count > 0 ? <Badge size="1" color="red">{count} to review</Badge> : null}
    </Flex>
  );
}

export default function GmailInbox({
  state,
  expanded,
  chat,
}: {
  state: GmailInboxState;
  expanded: boolean;
  chat: GmailChat;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState(state.searchQuery ?? "");
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [watchInstruction, setWatchInstruction] = useState("");
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(key: string, method: string, args: unknown = {}): Promise<T | undefined> {
    setBusy(key);
    setError(null);
    try {
      const result = (await chat.callMethodByHandle("gmail", method, args)) as T;
      setStatus(null);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function runAttention<T>(
    key: string,
    method: string,
    args: unknown = {}
  ): Promise<T | undefined> {
    setBusy(key);
    setError(null);
    try {
      const objectKey = `gmail-${chat.channelId}`;
      const target = await chat.rpc.call<{ targetId: string }>(
        "main",
        "workers.resolveDurableObject",
        ["workers/gmail-agent", "GmailAgentWorker", objectKey]
      );
      const result = await chat.rpc.call<T>(target.targetId, method, [chat.channelId, args]);
      setStatus(null);
      return result as T;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function openThread(item: GmailThreadCardState) {
    // Publishes (or refreshes) a standalone gmail.thread card in the channel.
    await run(`open:${item.threadId}`, "openThread", { threadId: item.threadId });
  }

  async function installWatchInstruction() {
    const instruction = watchInstruction.trim();
    if (!instruction) return;
    await runAttention("watch", "upsertAttentionRule", {
      rule: directiveFromInstruction(instruction, directives.length + 1),
    });
    await run("configure", "markConfigured", { summary: `Watching: ${instruction}` });
    setStatus("Watch rule installed");
    setWatchInstruction("");
  }

  async function installPreset(instruction: string) {
    if (instruction === "Quiet mode") {
      await runAttention("quiet", "clearAttentionRules");
      await run("configure", "markConfigured", { summary: "Quiet mode: no incoming email wakes the agent." });
      setStatus("Quiet mode installed");
      return;
    }
    await runAttention("preset", "upsertAttentionRule", {
      rule: directiveFromInstruction(instruction, directives.length + 1),
    });
    await run("configure", "markConfigured", { summary: `Watching: ${instruction}` });
    setStatus(`Watch rule installed: ${instruction}`);
  }

  async function updateDirective(directiveId: string, patch: Partial<GmailAttentionDirective>) {
    const directive = state.attentionRules?.directives.find((item) => item.id === directiveId);
    if (!directive) return;
    const next = { ...directive, ...patch };
    await runAttention("rules", "upsertAttentionRule", { rule: next });
    setStatus("Watch rules updated");
  }

  async function removeDirective(directiveId: string) {
    await runAttention("rules", "deleteAttentionRule", { id: directiveId });
    setStatus("Watch rule removed");
  }

  async function resetRules() {
    await runAttention("rules", "resetAttentionRules");
    setStatus("Default watch rules restored");
  }

  function toggleSelected(threadId: string, checked: boolean) {
    setSelectedThreadIds((current) => {
      const next = new Set(current);
      if (checked) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }

  async function runBulk(method: "archiveThread" | "markRead") {
    const ids = [...selectedThreadIds];
    if (ids.length === 0) return;
    for (const threadId of ids) {
      await run(`${method}:${threadId}`, method, { threadId });
    }
    setSelectedThreadIds(new Set());
    setStatus(method === "archiveThread" ? "Selected threads archived" : "Selected threads marked read");
  }

  if (!expanded) return <Pill state={state} />;

  const actionable = state.actionable ?? [];
  const searchResults = state.searchResults ?? [];
  const directives = state.attentionRules?.directives ?? [];
  const hits = state.attentionHits ?? [];
  const lastSynced = state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : "Not synced";

  return (
    <Flex direction="column" gap="3">
      <Flex align="start" justify="between" gap="3" wrap="wrap">
        <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
          <Flex align="center" gap="2" wrap="wrap">
            <EnvelopeClosedIcon />
            <Text size="3" weight="bold">Gmail desk</Text>
            <Badge color={state.lastError ? "red" : "green"} variant="soft">
              {state.lastError ? "Sync issue" : "Live"}
            </Badge>
          </Flex>
          <Text size="1" color="gray">{state.email ?? "Gmail account"} - {lastSynced}</Text>
        </Flex>
        <Flex gap="1" wrap="wrap">
          <Badge color="blue" variant="soft">{state.unread} unread</Badge>
          <Badge color="gray" variant="soft">{state.inbox ?? 0} inbox</Badge>
          <Badge color="orange" variant="soft">{actionable.length} actionable</Badge>
          {(state.urgent ?? 0) > 0 ? <Badge color="red" variant="soft">{state.urgent} urgent</Badge> : null}
          {(state.needsAttentionCount ?? 0) > 0 ? (
            <Badge color="amber" variant="soft">{state.needsAttentionCount} awaiting digest</Badge>
          ) : null}
        </Flex>
      </Flex>

      {state.lastError || (state.rateLimitedUntil && state.rateLimitedUntil > Date.now()) ? (
        <Callout.Root color={state.lastError ? "red" : "amber"} size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text>
            <Flex align="center" gap="2" wrap="wrap">
              <span>
                {state.lastError ??
                  `Rate limited until ${new Date(state.rateLimitedUntil!).toLocaleTimeString()}.`}
              </span>
              <Button
                size="1"
                variant="soft"
                disabled={busy !== null}
                onClick={() => void run("check", "checkNow")}
              >
                <ReloadIcon /> Retry now
              </Button>
            </Flex>
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {error ? <Text size="1" color="red">{error}</Text> : null}
      {status && !error ? <Text size="1" color="gray">{status}</Text> : null}

      <Flex align="center" gap="2" wrap="wrap">
        <Button
          size="1"
          variant="soft"
          disabled={busy !== null}
          title="Check now"
          onClick={() => void run("check", "checkNow")}
        >
          <ReloadIcon /> {busy === "check" ? "Checking" : "Check"}
        </Button>
        <Button
          size="1"
          variant="soft"
          disabled={busy !== null}
          title="Compose"
          onClick={() => void run("compose", "compose")}
        >
          <Pencil1Icon /> Compose
        </Button>
        <Flex align="center" gap="1" style={{ flex: "1 1 260px", minWidth: 220 }}>
          <TextField.Root
            size="1"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search mail"
            style={{ flex: 1 }}
          />
          <Button
            size="1"
            disabled={busy !== null || !query.trim()}
            title="Search"
            onClick={() => void run("search", "search", { q: query.trim() })}
          >
            <MagnifyingGlassIcon /> Search
          </Button>
        </Flex>
      </Flex>

      <Flex
        direction="column"
        gap="2"
        style={{
          border: "1px solid var(--gray-a5)",
          borderRadius: 6,
          padding: "10px",
        }}
      >
        <Flex align="center" justify="between" gap="2" wrap="wrap">
          <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
            <Text size="2" weight="medium">Attention rules</Text>
            <Text size="1" color="gray">
              Static wake rules run on incoming metadata and snippets before any semantic work.
            </Text>
          </Flex>
          <Button
            size="1"
            variant="ghost"
            disabled={busy !== null}
            title="Restore default attention rules"
            onClick={() => void resetRules()}
          >
            Reset
          </Button>
        </Flex>

        {directives.length === 0 ? (
          <Flex direction="column" gap="2">
            <Text size="2" weight="medium">Choose what Gmail should wake up for</Text>
            <Flex gap="1" wrap="wrap">
              {WATCH_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  size="1"
                  variant={preset === "Quiet mode" ? "ghost" : "soft"}
                  disabled={busy !== null}
                  onClick={() => void installPreset(preset)}
                >
                  {preset}
                </Button>
              ))}
            </Flex>
          </Flex>
        ) : null}

        <Flex align="center" gap="1" wrap="wrap">
          <TextField.Root
            size="1"
            value={watchInstruction}
            onChange={(event) => setWatchInstruction(event.target.value)}
            placeholder='Watch for invoices, scheduling, a sender, a domain, or "every email"'
            style={{ flex: "1 1 300px", minWidth: 240 }}
          />
          <Button
            size="1"
            disabled={busy !== null || !watchInstruction.trim()}
            onClick={() => void installWatchInstruction()}
          >
            {busy === "watch" ? "Installing" : "Install watch"}
          </Button>
        </Flex>

        {directives.length > 0 ? (
          <Flex direction="column" gap="2">
            {directives.map((directive) => (
              <RuleRow
                key={directive.id}
                directive={directive}
                busy={busy}
                onToggle={() => void updateDirective(directive.id, { enabled: !directive.enabled })}
                onDelete={() => void removeDirective(directive.id)}
              />
            ))}
          </Flex>
        ) : (
          <Text size="2" color="gray">No custom wake rules yet. Add one above.</Text>
        )}

        {hits.length > 0 ? (
          <Flex direction="column" gap="1">
            <Text size="1" color="gray">Recent wakes</Text>
            {hits.slice(0, 3).map((hit) => (
              <Text key={`${hit.threadId}:${hit.directiveId}`} size="1" color="gray">
                {hit.directiveName}: {hit.reason}
              </Text>
            ))}
          </Flex>
        ) : null}

      </Flex>

      <ThreadList
        title="Needs attention"
        empty="No unread primary threads addressed to you."
        threads={actionable}
        busy={busy}
        selectedThreadIds={selectedThreadIds}
        onSelect={toggleSelected}
        onBulkArchive={() => void runBulk("archiveThread")}
        onBulkRead={() => void runBulk("markRead")}
        onOpen={openThread}
        onDraft={(threadId) => void run(`draft:${threadId}`, "draftReply", { threadId })}
        onArchive={(threadId) => void run(`archive:${threadId}`, "archiveThread", { threadId })}
        onRead={(threadId) => void run(`read:${threadId}`, "markRead", { threadId })}
      />

      {state.searchQuery ? (
        <>
          <Separator size="4" />
          <Flex align="center" justify="between" gap="2">
            <Button
              size="1"
              variant="ghost"
              onClick={() => setSearchCollapsed((collapsed) => !collapsed)}
            >
              {searchCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              <Text size="2" weight="medium">
                Search: {state.searchQuery} ({searchResults.length})
              </Text>
            </Button>
            <Button
              size="1"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void run("clear-search", "clearSearch")}
            >
              Clear
            </Button>
          </Flex>
          {searchCollapsed ? null : (
          <ThreadList
            title=""
            empty="No matching messages."
            threads={searchResults}
            busy={busy}
            selectedThreadIds={selectedThreadIds}
            onSelect={toggleSelected}
            onBulkArchive={() => void runBulk("archiveThread")}
            onBulkRead={() => void runBulk("markRead")}
            onOpen={openThread}
            onDraft={(threadId) => void run(`draft:${threadId}`, "draftReply", { threadId })}
            onArchive={(threadId) => void run(`archive:${threadId}`, "archiveThread", { threadId })}
            onRead={(threadId) => void run(`read:${threadId}`, "markRead", { threadId })}
          />
          )}
        </>
      ) : null}
    </Flex>
  );
}

function directiveFromInstruction(instruction: string, index: number): GmailAttentionDirective {
  const text = instruction.trim();
  const lower = text.toLowerCase();
  const conditions: GmailAttentionCondition[] = [];
  const not: GmailAttentionCondition[] = [];
  const emails = Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)).map(
    (match) => match[0]
  );
  for (const email of emails) conditions.push({ field: "from", op: "contains", value: email });

  const domains = Array.from(text.matchAll(/\b(?:from|domain)\s+([a-z0-9.-]+\.[a-z]{2,})\b/gi));
  for (const match of domains) {
    conditions.push({ field: "fromDomain", op: "equals", value: match[1]!.toLowerCase() });
  }

  if (/\bevery\s+(email|message)|all\s+(email|mail|messages)|wake\s+all\b/i.test(text)) {
    conditions.push({ field: "wakeAll", op: "present" });
  }
  if (/\breplied|responded|known\s+(sender|contact|correspondent)|people\s+i\s+have\s+replied\b/i.test(text)) {
    conditions.push({ field: "priorReplyToSender", op: "present" });
    conditions.push({ field: "label", op: "contains", value: "INBOX" });
    conditions.push({ field: "label", op: "contains", value: "UNREAD" });
  }
  addKeywordConditions(text, lower, conditions, /\binvoice|receipt|payment|billing|paid|overdue\b/i, [
    "invoice",
    "receipt",
    "payment",
    "billing",
    "overdue",
  ]);
  addKeywordConditions(text, lower, conditions, /\bschedul|calendar|meeting|availability|available|reschedule|appointment\b/i, [
    "schedule",
    "calendar",
    "meeting",
    "available",
    "reschedule",
    "appointment",
  ]);
  addKeywordConditions(text, lower, conditions, /\burgent|outage|incident|production|operational|blocked|asap|immediately\b/i, [
    "urgent",
    "outage",
    "incident",
    "production",
    "blocked",
    "asap",
    "immediately",
  ]);
  if (/\battachment|attached|pdf|file\b/i.test(text)) {
    conditions.push({ field: "hasAttachment", op: "present" });
  }
  for (const category of ["promotions", "social", "updates", "forums", "primary"]) {
    if (!lower.includes(category)) continue;
    const value = category[0]!.toUpperCase() + category.slice(1);
    if (/\bignore|skip|unless\b/i.test(text) && category !== "primary") {
      not.push({ field: "category", op: "equals", value });
    } else {
      conditions.push({ field: "category", op: "equals", value });
    }
  }
  for (const phrase of Array.from(text.matchAll(/"([^"]{2,80})"/g)).map((match) => match[1]!.trim())) {
    conditions.push({ field: "subject", op: "contains", value: phrase });
    conditions.push({ field: "snippet", op: "contains", value: phrase });
  }
  if (conditions.length === 0) {
    const compact = text.replace(/[^\w\s-]/g, " ").trim().split(/\s+/).slice(0, 5).join(" ");
    conditions.push({ field: "subject", op: "contains", value: compact || text });
    conditions.push({ field: "snippet", op: "contains", value: compact || text });
  }

  const actions: GmailAttentionAction[] = ["surface"];
  if (/\bsummar/i.test(text)) actions.push("summarize");
  if (/\bdraft|reply|respond\b/i.test(text)) actions.push("draft");
  if (/\barchive\b/i.test(text)) actions.push("archive");
  if (/\bread\b/i.test(text)) actions.push("markRead");

  return {
    id: slug(text) || `rule-${index}`,
    name: text.slice(0, 80),
    description: text,
    enabled: true,
    scope: "snippet",
    priority: 100,
    match: {
      any: dedupeConditions(conditions),
      ...(not.length > 0 ? { not: dedupeConditions(not) } : {}),
    },
    actions: Array.from(new Set(actions)),
  };
}

function addKeywordConditions(
  text: string,
  lower: string,
  conditions: GmailAttentionCondition[],
  pattern: RegExp,
  tokens: string[]
) {
  if (!pattern.test(text)) return;
  for (const token of tokens) {
    if (!lower.includes(token)) continue;
    conditions.push({ field: "subject", op: "contains", value: token });
    conditions.push({ field: "snippet", op: "contains", value: token });
  }
}

function dedupeConditions(conditions: GmailAttentionCondition[]): GmailAttentionCondition[] {
  const seen = new Set<string>();
  return conditions.filter((condition) => {
    const key = JSON.stringify(condition);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function ThreadList({
  title,
  empty,
  threads,
  busy,
  selectedThreadIds,
  onSelect,
  onBulkArchive,
  onBulkRead,
  onOpen,
  onDraft,
  onArchive,
  onRead,
}: {
  title: string;
  empty: string;
  threads: GmailThreadCardState[];
  busy: string | null;
  selectedThreadIds: Set<string>;
  onSelect: (threadId: string, checked: boolean) => void;
  onBulkArchive: () => void;
  onBulkRead: () => void;
  onOpen: (thread: GmailThreadCardState) => void;
  onDraft: (threadId: string) => void;
  onArchive: (threadId: string) => void;
  onRead: (threadId: string) => void;
}) {
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="2" wrap="wrap">
        {title ? <Text size="2" weight="medium">{title}</Text> : <span />}
        {selectedThreadIds.size > 0 ? (
          <Flex align="center" gap="1" wrap="wrap">
            <Text size="1" color="gray">{selectedThreadIds.size} selected</Text>
            <Button size="1" variant="ghost" disabled={busy !== null} onClick={onBulkRead}>
              Mark read
            </Button>
            <Button size="1" variant="ghost" disabled={busy !== null} onClick={onBulkArchive}>
              Archive
            </Button>
          </Flex>
        ) : null}
      </Flex>
      {threads.length === 0 ? <Text size="2" color="gray">{empty}</Text> : null}
      {threads.map((thread) => (
        <Flex
          key={thread.threadId}
          align="center"
          justify="between"
          gap="2"
          style={{
            border: "1px solid var(--gray-a5)",
            borderRadius: 6,
            padding: "8px",
            minWidth: 0,
          }}
        >
          <Checkbox
            checked={selectedThreadIds.has(thread.threadId)}
            onCheckedChange={(checked) => onSelect(thread.threadId, checked === true)}
          />
          <Box style={{ minWidth: 0, flex: "1 1 auto" }}>
            <Flex align="center" gap="1" wrap="wrap">
              <Text size="2" weight={thread.unreadCount ? "bold" : "medium"} style={{ wordBreak: "break-word" }}>
                {thread.subject}
              </Text>
              {thread.category ? <Badge size="1" color="gray" variant="soft">{thread.category}</Badge> : null}
              {thread.attention?.directiveName ? (
                <Badge size="1" color="amber" variant="soft">{thread.attention.directiveName}</Badge>
              ) : null}
            </Flex>
            <Text size="1" color="gray" style={{ display: "block", wordBreak: "break-word" }}>
              {thread.from || thread.participants?.[0] || "Unknown sender"}
            </Text>
            <Text size="1" color="gray" style={{ display: "block", wordBreak: "break-word" }}>
              {thread.lastSnippet || thread.snippet || ""}
            </Text>
            {thread.attention?.reason ? (
              <Text size="1" color="amber" style={{ display: "block", wordBreak: "break-word" }}>
                {thread.attention.reason}
              </Text>
            ) : null}
          </Box>
          <Flex gap="1" wrap="wrap" justify="end" style={{ flex: "0 0 auto" }}>
            <Button size="1" variant="ghost" disabled={busy !== null} title="Open" onClick={() => onOpen(thread)}>
              Open
            </Button>
            <Button size="1" variant="soft" disabled={busy !== null} title="Draft reply" onClick={() => onDraft(thread.threadId)}>
              <Pencil1Icon /> Draft
            </Button>
            <Button size="1" variant="ghost" disabled={busy !== null} title="Mark read" onClick={() => onRead(thread.threadId)}>
              <CheckIcon />
            </Button>
            <Button size="1" variant="ghost" disabled={busy !== null} title="Archive" onClick={() => onArchive(thread.threadId)}>
              <ArchiveIcon />
            </Button>
          </Flex>
        </Flex>
      ))}
    </Flex>
  );
}

function RuleRow({
  directive,
  busy,
  onToggle,
  onDelete,
}: {
  directive: GmailAttentionDirective;
  busy: string | null;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <Flex
      align="center"
      justify="between"
      gap="2"
      wrap="wrap"
      style={{
        border: "1px solid var(--gray-a5)",
        borderRadius: 6,
        padding: "8px",
      }}
    >
      <Box style={{ minWidth: 0, flex: "1 1 280px" }}>
        <Flex align="center" gap="1" wrap="wrap">
          <Badge color={directive.enabled ? "blue" : "gray"} variant="soft">
            {directive.enabled ? "On" : "Paused"}
          </Badge>
          <Text size="2" weight="medium" style={{ wordBreak: "break-word" }}>
            {directive.name}
          </Text>
          <Badge color="gray" variant="soft">{scopeLabel(directive.scope)}</Badge>
        </Flex>
        {directive.description ? (
          <Text size="1" color="gray" style={{ display: "block", wordBreak: "break-word" }}>
            {directive.description}
          </Text>
        ) : null}
        <Text size="1" color="gray" style={{ display: "block", wordBreak: "break-word" }}>
          {formatMatcher(directive.match)}
        </Text>
        <Flex gap="1" wrap="wrap" style={{ marginTop: 4 }}>
          {directive.actions.map((action) => (
            <Badge key={action} size="1" color="gray" variant="soft">
              {actionLabel(action)}
            </Badge>
          ))}
        </Flex>
      </Box>
      <Flex gap="1" wrap="wrap" justify="end" style={{ flex: "0 0 auto" }}>
        <Button size="1" variant="ghost" disabled={busy !== null} onClick={onToggle}>
          {directive.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="1" variant="ghost" color="red" disabled={busy !== null} onClick={onDelete}>
          Delete
        </Button>
      </Flex>
    </Flex>
  );
}

function scopeLabel(scope: GmailAttentionScope): string {
  if (scope === "metadata") return "Metadata";
  if (scope === "full-thread-on-wake") return "Thread after wake";
  return "Snippet";
}

function actionLabel(action: GmailAttentionAction): string {
  if (action === "markRead") return "Mark read";
  return action[0]!.toUpperCase() + action.slice(1);
}

function formatMatcher(match: GmailAttentionMatcher): string {
  const parts: string[] = [];
  if (match.any?.length) parts.push(`Any: ${match.any.map(formatCondition).join(", ")}`);
  if (match.all?.length) parts.push(`All: ${match.all.map(formatCondition).join(", ")}`);
  if (match.not?.length) parts.push(`Except: ${match.not.map(formatCondition).join(", ")}`);
  return parts.join(" | ") || "No matcher";
}

function formatCondition(condition: GmailAttentionCondition): string {
  const field = condition.field ?? "field";
  if (field === "priorReplyToSender") return "sender already replied to";
  if (field === "wakeAll") return "every incoming message";
  if (field === "hasAttachment") return "has attachment";
  const op = condition.op ?? (field === "fromDomain" ? "equals" : "contains");
  return `${field} ${op} ${condition.value ?? ""}`.trim();
}

