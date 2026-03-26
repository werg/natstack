/**
 * Email Workspace Panel
 *
 * Example panel demonstrating how a Gmail/Calendar integration would work
 * in NatStack. Tests the boundaries of the current panel system and
 * identifies what runtime services need to be added (primarily OAuth).
 *
 * Architecture:
 * - oauth.ts    — Token provider abstraction (OAuth service)
 * - gmail.ts    — Gmail & Calendar REST API clients
 * - contract.ts — RPC contract for parent panel communication
 * - index.tsx   — UI (this file)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  rpc,
  useStateArgs,
  setStateArgs,
  getParentWithContract,
  noopParent,
} from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import {
  Theme,
  Flex,
  Box,
  Text,
  Button,
  Badge,
  Card,
  Heading,
  Separator,
  TextField,
  TextArea,
  Spinner,
  Tabs,
  ScrollArea,
  IconButton,
  Tooltip,
} from "@radix-ui/themes";
import {
  EnvelopeClosedIcon,
  EnvelopeOpenIcon,
  CalendarIcon,
  PaperPlaneIcon,
  ReloadIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  CheckCircledIcon,
  Cross2Icon,
  ArrowLeftIcon,
  PersonIcon,
} from "@radix-ui/react-icons";

import { emailContract } from "./contract.js";
import { createTokenProvider } from "./oauth.js";
import * as gmail from "@workspace/integrations/gmail";
import * as calendar from "@workspace/integrations/calendar";
import type { GmailMessage, GmailThread } from "@workspace/integrations/gmail";
import type { CalendarEvent } from "@workspace/integrations/calendar";
import type { OAuthTokenProvider } from "./oauth.js";

// ---- State Args ----

interface EmailStateArgs {
  provider?: string;
  connectionId?: string;
  view?: "inbox" | "thread" | "compose" | "calendar";
  threadId?: string;
}

// ---- Main Component ----

export default function EmailPanel() {
  const appearance = usePanelTheme();
  const stateArgs = useStateArgs<EmailStateArgs>();
  const parent = getParentWithContract(emailContract) ?? noopParent;

  const [view, setView] = useState<"inbox" | "thread" | "compose" | "calendar">(
    stateArgs?.view ?? "inbox",
  );
  const [connectionStatus, setConnectionStatus] = useState<{
    connected: boolean;
    email?: string;
    error?: string;
    checking: boolean;
  }>({ connected: false, checking: true });

  const [tokenProvider, setTokenProvider] = useState<OAuthTokenProvider | null>(null);
  const [composeDraft, setComposeDraft] = useState<{ to?: string; subject?: string; body?: string } | undefined>();

  // Initialize auth on mount
  useEffect(() => {
    async function init() {
      const provider = createTokenProvider({
        providerKey: stateArgs?.provider ?? "google-mail",
        connectionId: stateArgs?.connectionId,
      });
      setTokenProvider(provider);

      // Check connection
      try {
        const conn = await provider.getConnection();
        if (conn.connected) {
          setConnectionStatus({ connected: true, email: conn.email, checking: false });
          parent.emit("connection-changed", { connected: true, email: conn.email });
        } else {
          setConnectionStatus({ connected: false, checking: false });
        }
      } catch (err) {
        setConnectionStatus({ connected: false, error: String(err), checking: false });
      }
    }
    init();
  }, [stateArgs?.provider, stateArgs?.connectionId]);

  // Expose RPC methods for parent panels / agents
  useEffect(() => {
    rpc.expose({
      async getConnectionStatus() {
        return {
          connected: connectionStatus.connected,
          email: connectionStatus.email,
          provider: stateArgs?.provider ?? "google-mail",
        };
      },
      async search(query: string, maxResults?: number) {
        if (!connectionStatus.connected) throw new Error("Not connected");
        const messages = await gmail.search(query, maxResults);
        return messages.map(m => ({
          id: m.id,
          threadId: m.threadId,
          subject: m.subject,
          from: m.from,
          date: m.date,
          snippet: m.snippet,
        }));
      },
      async getThread(threadId: string) {
        if (!connectionStatus.connected) throw new Error("Not connected");
        return gmail.getThread(threadId);
      },
      async compose(draft?: { to?: string; subject?: string; body?: string }) {
        setComposeDraft(draft);
        setView("compose");
      },
      async getCalendarEvents(timeMin?: string, timeMax?: string, maxResults?: number) {
        if (!connectionStatus.connected) throw new Error("Not connected");
        return calendar.listEvents({ timeMin, timeMax, maxResults });
      },
    });
  }, [connectionStatus]);

  const [connectMessage, setConnectMessage] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    if (!tokenProvider) return;
    setConnectionStatus(s => ({ ...s, checking: true, error: undefined }));
    setConnectMessage("Requesting access...");
    try {
      const conn = await tokenProvider.connect((stage, message) => {
        setConnectMessage(message);
      });
      setConnectMessage(null);
      setConnectionStatus({ connected: true, email: conn.email, checking: false });
      parent.emit("connection-changed", { connected: true, email: conn.email });
    } catch (err) {
      setConnectMessage(null);
      const msg = err instanceof Error ? err.message : String(err);
      // Make common errors user-friendly
      const userMessage = msg.includes("consent denied")
        ? "Access was denied. Click Connect to try again."
        : msg.includes("timed out")
          ? "Sign-in timed out. Click Connect to try again."
          : msg.includes("not configured")
            ? "OAuth is not configured. Ask the agent to help you set up Nango for OAuth access."
            : msg;
      setConnectionStatus({ connected: false, error: userMessage, checking: false });
    }
  }, [tokenProvider, parent]);

  return (
    <Theme appearance={appearance} accentColor="blue">
      <Flex direction="column" style={{ height: "100vh", overflow: "hidden" }}>
        {/* Header */}
        <Flex
          align="center"
          justify="between"
          px="3"
          py="2"
          style={{ borderBottom: "1px solid var(--gray-a5)" }}
        >
          <Flex align="center" gap="2">
            <EnvelopeClosedIcon />
            <Heading size="3">Email</Heading>
            {connectionStatus.connected && connectionStatus.email && (
              <Badge size="1" variant="soft" color="green">
                {connectionStatus.email}
              </Badge>
            )}
          </Flex>
          <Flex align="center" gap="2">
            <Tabs.Root value={view} onValueChange={v => {
              setView(v as typeof view);
              setStateArgs({ ...stateArgs, view: v, threadId: undefined });
            }}>
              <Tabs.List size="1">
                <Tabs.Trigger value="inbox">
                  <EnvelopeClosedIcon /> Inbox
                </Tabs.Trigger>
                <Tabs.Trigger value="calendar">
                  <CalendarIcon /> Calendar
                </Tabs.Trigger>
                <Tabs.Trigger value="compose">
                  <PaperPlaneIcon /> Compose
                </Tabs.Trigger>
              </Tabs.List>
            </Tabs.Root>
          </Flex>
        </Flex>

        {/* Content */}
        <Box style={{ flex: 1, overflow: "hidden" }}>
          {connectionStatus.checking ? (
            <Flex align="center" justify="center" direction="column" gap="2" style={{ height: "100%" }}>
              <Spinner size="3" />
              <Text size="2">{connectMessage ?? "Checking connection..."}</Text>
            </Flex>
          ) : !connectionStatus.connected ? (
            <ConnectionSetup
              error={connectionStatus.error}
              onConnect={handleConnect}
            />
          ) : view === "inbox" ? (
            <InboxView
              onOpenThread={(threadId, subject) => {
                setView("thread");
                setStateArgs({ ...stateArgs, view: "thread", threadId });
                parent.emit("thread-opened", { threadId, subject });
              }}
            />
          ) : view === "thread" ? (
            <ThreadView
              threadId={stateArgs?.threadId ?? ""}
              onBack={() => {
                setView("inbox");
                setStateArgs({ ...stateArgs, view: "inbox", threadId: undefined });
              }}
              onReply={(threadId) => {
                setView("compose");
                setStateArgs({ ...stateArgs, view: "compose", threadId });
              }}
            />
          ) : view === "compose" ? (
            <ComposeView
              threadId={stateArgs?.threadId}
              draft={composeDraft}
              onSent={(to, subject) => {
                setComposeDraft(undefined);
                parent.emit("message-sent", { to, subject });
                setView("inbox");
                setStateArgs({ ...stateArgs, view: "inbox", threadId: undefined });
              }}
              onCancel={() => {
                setView("inbox");
                setStateArgs({ ...stateArgs, view: "inbox", threadId: undefined });
              }}
            />
          ) : view === "calendar" ? (
            <CalendarView />
          ) : null}
        </Box>
      </Flex>
    </Theme>
  );
}

// ---- Connection Setup ----

function ConnectionSetup({
  error,
  onConnect,
}: {
  error?: string;
  onConnect: () => void;
}) {
  return (
    <Flex align="center" justify="center" style={{ height: "100%" }}>
      <Card size="3" style={{ maxWidth: 520 }}>
        <Flex direction="column" gap="4" align="center">
          <EnvelopeClosedIcon width={32} height={32} />
          <Heading size="4">Connect Your Email</Heading>
          <Text size="2" color="gray" align="center">
            This panel needs access to your Gmail account. Connect via OAuth
            to get started.
          </Text>

          {error && (
            <Card variant="surface" style={{ width: "100%" }}>
              <Flex direction="column" gap="2">
                <Flex align="center" gap="1">
                  <ExclamationTriangleIcon color="var(--orange-9)" />
                  <Text size="2" weight="bold" color="orange">Setup Required</Text>
                </Flex>
                <Text
                  size="1"
                  color="gray"
                  style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}
                >
                  {error}
                </Text>
              </Flex>
            </Card>
          )}

          <Separator size="4" />

          <Flex direction="column" gap="2" style={{ width: "100%" }}>
            <Text size="1" color="gray">
              Clicking Connect will request OAuth access via a notification
              in the shell chrome. After approval, a browser panel opens
              to complete the Google sign-in flow.
            </Text>
            <Button onClick={onConnect} size="2">
              Connect with OAuth
            </Button>
          </Flex>
        </Flex>
      </Card>
    </Flex>
  );
}

// ---- Inbox View ----

function InboxView({
  onOpenThread,
}: {
  onOpenThread: (threadId: string, subject: string) => void;
}) {
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState("");

  const loadMessages = useCallback(async (query?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const msgs = await gmail.search(query ?? "in:inbox", 20);
      setMessages(msgs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  const handleSearch = () => {
    loadMessages(searchQuery || "in:inbox");
  };

  return (
    <Flex direction="column" style={{ height: "100%" }}>
      {/* Search bar */}
      <Flex gap="2" p="2" style={{ borderBottom: "1px solid var(--gray-a5)" }}>
        <Box style={{ flex: 1 }}>
          <TextField.Root
            placeholder="Search mail... (e.g. from:alice subject:meeting)"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSearch()}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
          </TextField.Root>
        </Box>
        <Tooltip content="Refresh">
          <IconButton variant="soft" onClick={() => loadMessages()}>
            <ReloadIcon />
          </IconButton>
        </Tooltip>
      </Flex>

      {/* Message list */}
      <ScrollArea style={{ flex: 1 }}>
        {loading ? (
          <Flex align="center" justify="center" p="4">
            <Spinner size="2" />
          </Flex>
        ) : error ? (
          <Flex direction="column" align="center" gap="2" p="4">
            <ExclamationTriangleIcon color="var(--red-9)" />
            <Text size="2" color="red">{error}</Text>
            <Button size="1" variant="soft" onClick={() => loadMessages()}>
              Retry
            </Button>
          </Flex>
        ) : messages.length === 0 ? (
          <Flex align="center" justify="center" p="4">
            <Text size="2" color="gray">No messages found</Text>
          </Flex>
        ) : (
          <Flex direction="column">
            {messages.map(msg => (
              <MessageRow
                key={msg.id}
                message={msg}
                onClick={() => onOpenThread(msg.threadId, msg.subject)}
              />
            ))}
          </Flex>
        )}
      </ScrollArea>
    </Flex>
  );
}

function MessageRow({
  message,
  onClick,
}: {
  message: GmailMessage;
  onClick: () => void;
}) {
  const fromName = message.from.replace(/<[^>]+>/, "").trim();
  const date = formatRelativeDate(message.date);

  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      style={{
        padding: "8px 12px",
        cursor: "pointer",
        borderBottom: "1px solid var(--gray-a3)",
        backgroundColor: message.isUnread ? "var(--blue-a2)" : undefined,
      }}
      onMouseEnter={e => (e.currentTarget.style.backgroundColor = "var(--gray-a3)")}
      onMouseLeave={e =>
        (e.currentTarget.style.backgroundColor = message.isUnread ? "var(--blue-a2)" : "")
      }
      onFocus={e => (e.currentTarget.style.backgroundColor = "var(--gray-a3)")}
      onBlur={e =>
        (e.currentTarget.style.backgroundColor = message.isUnread ? "var(--blue-a2)" : "")
      }
    >
      <Flex justify="between" align="start" gap="2">
        <Flex direction="column" gap="1" style={{ flex: 1, minWidth: 0 }}>
          <Flex align="center" gap="2">
            {message.isUnread ? <EnvelopeClosedIcon /> : <EnvelopeOpenIcon />}
            <Text
              size="2"
              weight={message.isUnread ? "bold" : "regular"}
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {fromName}
            </Text>
          </Flex>
          <Text
            size="2"
            weight={message.isUnread ? "bold" : "regular"}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {message.subject}
          </Text>
          <Text
            size="1"
            color="gray"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {message.snippet}
          </Text>
        </Flex>
        <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
          {date}
        </Text>
      </Flex>
    </Box>
  );
}

// ---- Thread View ----

function ThreadView({
  threadId,
  onBack,
  onReply,
}: {
  threadId: string;
  onBack: () => void;
  onReply: (threadId: string) => void;
}) {
  const [thread, setThread] = useState<GmailThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!threadId) return;
    setLoading(true);
    gmail
      .getThread(threadId)
      .then(setThread)
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [threadId]);

  if (!threadId) {
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Text color="gray">No thread selected</Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" style={{ height: "100%" }}>
      <Flex align="center" gap="2" p="2" style={{ borderBottom: "1px solid var(--gray-a5)" }}>
        <IconButton variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
        </IconButton>
        <Text size="3" weight="bold" style={{ flex: 1 }}>
          {thread?.subject ?? "Loading..."}
        </Text>
        <Button size="1" onClick={() => onReply(threadId)}>
          <PaperPlaneIcon /> Reply
        </Button>
      </Flex>

      <ScrollArea style={{ flex: 1 }}>
        {loading ? (
          <Flex align="center" justify="center" p="4">
            <Spinner size="2" />
          </Flex>
        ) : error ? (
          <Box p="4"><Text size="2" color="red">{error}</Text></Box>
        ) : thread ? (
          <Flex direction="column" gap="3" p="3">
            {thread.messages.map(msg => (
              <Card key={msg.id} variant="surface">
                <Flex direction="column" gap="2">
                  <Flex justify="between" align="center">
                    <Flex align="center" gap="2">
                      <PersonIcon />
                      <Text size="2" weight="bold">{msg.from}</Text>
                    </Flex>
                    <Text size="1" color="gray">{formatRelativeDate(msg.date)}</Text>
                  </Flex>
                  <Text size="1" color="gray">
                    To: {msg.to.join(", ")}
                  </Text>
                  <Separator />
                  <Text
                    size="2"
                    style={{ whiteSpace: "pre-wrap", fontFamily: "var(--default-font-family)" }}
                  >
                    {msg.body}
                  </Text>
                </Flex>
              </Card>
            ))}
          </Flex>
        ) : null}
      </ScrollArea>
    </Flex>
  );
}

// ---- Compose View ----

function ComposeView({
  threadId,
  draft,
  onSent,
  onCancel,
}: {
  threadId?: string;
  draft?: { to?: string; subject?: string; body?: string };
  onSent: (to: string[], subject: string) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(draft?.to ?? "");
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  // Reset all fields when draft changes (including to blank for undefined/empty drafts)
  useEffect(() => {
    setTo(draft?.to ?? "");
    setSubject(draft?.subject ?? "");
    setBody(draft?.body ?? "");
  }, [draft]);

  const handleSend = async () => {
    if (!to.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const recipients = to.split(",").map(s => s.trim()).filter(Boolean);
      await gmail.send({
        to: recipients,
        subject,
        body,
        threadId,
      });
      onSent(recipients, subject);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Flex direction="column" style={{ height: "100%" }}>
      <Flex align="center" gap="2" p="2" style={{ borderBottom: "1px solid var(--gray-a5)" }}>
        <IconButton variant="ghost" onClick={onCancel}>
          <Cross2Icon />
        </IconButton>
        <Text size="3" weight="bold" style={{ flex: 1 }}>
          {threadId ? "Reply" : "New Message"}
        </Text>
        <Button onClick={handleSend} disabled={sending || !to.trim()}>
          {sending ? <Spinner size="1" /> : <PaperPlaneIcon />}
          Send
        </Button>
      </Flex>

      <Flex direction="column" gap="2" p="3" style={{ flex: 1 }}>
        <TextField.Root
          placeholder="To (comma-separated)"
          value={to}
          onChange={e => setTo(e.target.value)}
        />
        <TextField.Root
          placeholder="Subject"
          value={subject}
          onChange={e => setSubject(e.target.value)}
        />
        <TextArea
          placeholder="Write your message..."
          value={body}
          onChange={e => setBody(e.target.value)}
          style={{ flex: 1, minHeight: 200 }}
        />
        {error && (
          <Text size="1" color="red">{error}</Text>
        )}
      </Flex>
    </Flex>
  );
}

// ---- Calendar View ----

function CalendarView() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setLoading(true);
    calendar
      .listEvents({ maxResults: 20 })
      .then(setEvents)
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Flex direction="column" style={{ height: "100%" }}>
      <Flex align="center" gap="2" p="2" style={{ borderBottom: "1px solid var(--gray-a5)" }}>
        <CalendarIcon />
        <Text size="3" weight="bold">Upcoming Events</Text>
      </Flex>

      <ScrollArea style={{ flex: 1 }}>
        {loading ? (
          <Flex align="center" justify="center" p="4">
            <Spinner size="2" />
          </Flex>
        ) : error ? (
          <Flex direction="column" align="center" gap="2" p="4">
            <ExclamationTriangleIcon color="var(--red-9)" />
            <Text size="2" color="red">{error}</Text>
          </Flex>
        ) : events.length === 0 ? (
          <Flex align="center" justify="center" p="4">
            <Text size="2" color="gray">No upcoming events</Text>
          </Flex>
        ) : (
          <Flex direction="column" gap="2" p="3">
            {events.map(event => (
              <Card key={event.id} variant="surface">
                <Flex direction="column" gap="1">
                  <Flex justify="between" align="center">
                    <Text size="2" weight="bold">{event.summary}</Text>
                    <Badge size="1" variant="soft">
                      {formatEventTime(event.start, event.end)}
                    </Badge>
                  </Flex>
                  {event.location && (
                    <Text size="1" color="gray">{event.location}</Text>
                  )}
                  {event.attendees.length > 0 && (
                    <Flex gap="1" wrap="wrap">
                      {event.attendees.map(a => (
                        <Badge key={a} size="1" variant="outline">{a}</Badge>
                      ))}
                    </Flex>
                  )}
                </Flex>
              </Card>
            ))}
          </Flex>
        )}
      </ScrollArea>
    </Flex>
  );
}

// ---- Utilities ----

function formatRelativeDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

function formatEventTime(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const timeOpts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    const dateOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

    const today = new Date();
    const isToday = s.toDateString() === today.toDateString();
    const isTomorrow =
      s.toDateString() === new Date(today.getTime() + 86400000).toDateString();

    const prefix = isToday ? "Today" : isTomorrow ? "Tomorrow" : s.toLocaleDateString(undefined, dateOpts);
    return `${prefix} ${s.toLocaleTimeString(undefined, timeOpts)}–${e.toLocaleTimeString(undefined, timeOpts)}`;
  } catch {
    return `${start} – ${end}`;
  }
}
