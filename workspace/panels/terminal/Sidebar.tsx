import { Badge, Button, Flex, Text, TextField } from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@radix-ui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildSidebarGroups } from "./sidebarModel.js";
import type {
  NotificationSeverity,
  SessionInfo,
  TerminalNotification,
  TerminalTab,
} from "./types.js";

export function Sidebar(props: {
  tabs: TerminalTab[];
  sessions: Record<string, SessionInfo>;
  notifications: TerminalNotification[];
  activeTabId?: string;
  collapsed: boolean;
  focusSearchToken?: number;
  newTabPending?: boolean;
  newTabPendingLabel?: string;
  onCollapsedChange(collapsed: boolean): void;
  onSelect(tabId: string): void;
  onFocusSession(sessionId: string): void;
  onNewTab(): void;
  onOpenPort(sessionId: string, port: number): void;
  variant?: "desktop" | "drawer";
}) {
  const [filter, setFilter] = useState("");
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const groups = useMemo(
    () =>
      buildSidebarGroups({
        tabs: props.tabs,
        sessions: props.sessions,
        notifications: props.notifications,
        filter,
        now,
      }),
    [filter, now, props.notifications, props.sessions, props.tabs]
  );
  const rowCount = groups.reduce((count, group) => count + group.rows.length, 0);

  useEffect(() => {
    if (props.collapsed || !props.focusSearchToken) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [props.collapsed, props.focusSearchToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (props.collapsed && props.variant !== "drawer") {
    return (
      <Flex
        direction="column"
        align="center"
        width="3rem"
        p="2"
        gap="2"
        style={{ borderRight: "1px solid var(--gray-5)", background: "var(--gray-1)" }}
      >
        <Button
          size="1"
          variant="ghost"
          onClick={() => props.onCollapsedChange(false)}
          aria-label="Show terminal sidebar"
        >
          ›
        </Button>
        <Button
          size="1"
          variant="soft"
          onClick={props.onNewTab}
          disabled={props.newTabPending}
          aria-label={props.newTabPendingLabel ?? "New terminal"}
          title={props.newTabPending ? props.newTabPendingLabel : undefined}
        >
          <PlusIcon />
        </Button>
      </Flex>
    );
  }

  return (
    <Flex
      direction="column"
      width={props.variant === "drawer" ? "100%" : "17rem"}
      p="3"
      gap="3"
      style={{
        borderRight: props.variant === "drawer" ? undefined : "1px solid var(--gray-5)",
        background: "var(--gray-1)",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <Flex align="center" gap="2">
        <TextField.Root
          ref={searchRef}
          size="2"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter sessions"
          style={{ flex: 1 }}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
        </TextField.Root>
        <Button
          size="2"
          variant="soft"
          onClick={props.onNewTab}
          disabled={props.newTabPending}
          aria-label={props.newTabPendingLabel ?? "New terminal"}
          title={props.newTabPending ? props.newTabPendingLabel : undefined}
        >
          <PlusIcon />
        </Button>
        <Button
          size="2"
          variant="ghost"
          onClick={() => props.onCollapsedChange(true)}
          aria-label="Hide terminal sidebar"
        >
          ‹
        </Button>
      </Flex>
      {props.newTabPending ? (
        <Text size="1" color="gray" role="status" aria-live="polite">
          {props.newTabPendingLabel ?? "Starting terminal..."}
        </Text>
      ) : null}
      <Flex direction="column" gap="1">
        {groups.map((group) => {
          const open = !closedGroups.has(group.name);
          return (
            <div key={group.name}>
              <button
                onClick={() =>
                  setClosedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.name)) next.delete(group.name);
                    else next.add(group.name);
                    return next;
                  })
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                  width: "100%",
                  border: 0,
                  borderBottom: "1px solid var(--gray-5)",
                  padding: "var(--space-1) 0",
                  background: "transparent",
                  color: "var(--gray-11)",
                  textAlign: "left",
                }}
              >
                {open ? (
                  <ChevronDownIcon width="12" height="12" />
                ) : (
                  <ChevronRightIcon width="12" height="12" />
                )}
                <Text size="1" color="gray" style={{ textTransform: "uppercase", flex: 1 }}>
                  {group.name}
                </Text>
                <Badge size="1" variant="soft" color="gray">
                  {group.rows.length}
                </Badge>
              </button>
              {open
                ? group.rows.map((row) => {
                    const active =
                      props.activeTabId === row.tab.tabId &&
                      row.tab.focusedSessionId === row.sessionId;
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        key={`${row.tab.tabId}:${row.sessionId}`}
                        onClick={() => {
                          props.onSelect(row.tab.tabId);
                          props.onFocusSession(row.sessionId);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          props.onSelect(row.tab.tabId);
                          props.onFocusSession(row.sessionId);
                        }}
                        style={{
                          textAlign: "left",
                          border: 0,
                          borderRadius: "var(--radius-2)",
                          padding: "var(--space-2)",
                          minHeight: "3.25rem",
                          background: active ? "var(--accent-3)" : "transparent",
                          boxShadow: active ? "inset 3px 0 0 var(--accent-9)" : undefined,
                          color: "var(--gray-12)",
                          width: "100%",
                          cursor: "default",
                          outline: "none",
                        }}
                        onMouseEnter={(event) => {
                          if (!active) event.currentTarget.style.background = "var(--gray-3)";
                        }}
                        onMouseLeave={(event) => {
                          if (!active) event.currentTarget.style.background = "transparent";
                        }}
                      >
                        <Flex align="center" gap="2" minWidth="0">
                          <span
                            style={{
                              width: "0.5rem",
                              height: "0.5rem",
                              borderRadius: "999px",
                              background: severityColor(row.severity, row.alive),
                              flex: "0 0 auto",
                            }}
                          />
                          <Text size="2" weight="medium" truncate style={{ minWidth: 0 }}>
                            {row.title}
                          </Text>
                          {row.branch ? (
                            <Text
                              size="1"
                              color="gray"
                              truncate
                              style={{ minWidth: 0, flex: "0 1 auto" }}
                            >
                              {row.branch}
                            </Text>
                          ) : null}
                          {row.cwdBasename ? (
                            <Text
                              size="1"
                              color="gray"
                              truncate
                              style={{ minWidth: 0, flex: "0 1 auto" }}
                            >
                              {row.cwdBasename}
                            </Text>
                          ) : null}
                          {!active && row.unread > 0 ? (
                            <Badge size="1" color="amber" variant="soft">
                              {row.unread}
                            </Badge>
                          ) : null}
                        </Flex>
                        <Flex align="center" justify="between" gap="2" mt="1">
                          <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
                            {row.subtitle}
                          </Text>
                          <Flex gap="1" flexShrink="0">
                            {row.ports.map((port) => (
                              <button
                                key={port}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (row.session) props.onOpenPort(row.session.sessionId, port);
                                }}
                                style={{ border: 0, padding: 0, background: "transparent" }}
                              >
                                <Badge size="1" variant="soft" color="blue">
                                  :{port}
                                </Badge>
                              </button>
                            ))}
                            {row.extraPortCount > 0 ? (
                              <Badge size="1" variant="soft">
                                +{row.extraPortCount}
                              </Badge>
                            ) : null}
                          </Flex>
                        </Flex>
                      </div>
                    );
                  })
                : null}
            </div>
          );
        })}
        {rowCount === 0 ? (
          <Text size="1" color="gray" style={{ padding: "var(--space-2)" }}>
            No matching sessions
          </Text>
        ) : null}
      </Flex>
    </Flex>
  );
}

function severityColor(severity: NotificationSeverity | "idle", alive = false): string {
  if (severity === "failure") return "var(--red-9)";
  if (severity === "approval") return "var(--amber-9)";
  if (severity === "waiting") return "var(--blue-9)";
  if (severity === "done") return "var(--green-9)";
  if (severity === "info") return "var(--gray-9)";
  return alive ? "var(--green-9)" : "var(--gray-9)";
}
