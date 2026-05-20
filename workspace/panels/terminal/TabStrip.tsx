import { Badge, ContextMenu, DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";
import { BellIcon, Cross2Icon, DotsHorizontalIcon, PlusIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import { shouldShowTabClose, splitVisibleTabs, tabAdornment } from "./tabStripModel.js";
import type { NotificationSeverity, SessionInfo, TerminalNotification, TerminalTab } from "./types.js";

export function TabStrip(props: {
  tabs: TerminalTab[];
  activeTabId?: string;
  sessions: Record<string, SessionInfo>;
  notifications: TerminalNotification[];
  newTabPending?: boolean;
  newTabPendingLabel?: string;
  onSelect(tabId: string): void;
  onNewTab(): void;
  onClose(tabId: string): void;
  onCloseOthers(tabId: string): void;
  onDuplicate(tabId: string): void;
  onRename(tabId: string): void;
  onCustomize(tabId: string): void;
  onToggleNotifications(): void;
  onSaveLayout(tabId: string): void;
}) {
  const { visible, overflow } = splitVisibleTabs(props.tabs, props.activeTabId);
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [focusedCloseTabId, setFocusedCloseTabId] = useState<string | null>(null);
  return (
    <Flex align="center" gap="1" px="2" py="1" style={{ borderBottom: "1px solid var(--gray-5)", minWidth: 0 }}>
      <Flex align="center" gap="1" style={{ overflowX: "auto", minWidth: 0, flex: 1 }}>
        {visible.map((tab) => {
          const active = tab.tabId === props.activeTabId;
          const adornment = tabAdornment(tab, props.sessions, props.notifications);
          const showClose = shouldShowTabClose(tab.tabId, hoveredTabId, focusedCloseTabId);
          return (
            <ContextMenu.Root key={tab.tabId}>
              <ContextMenu.Trigger>
                <div
                  onMouseEnter={() => setHoveredTabId(tab.tabId)}
                  onMouseLeave={() => setHoveredTabId((value) => value === tab.tabId ? null : value)}
                  onAuxClick={(event) => {
                    if (event.button === 1) props.onClose(tab.tabId);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    height: "1.75rem",
                    maxWidth: "12rem",
                    minWidth: "5rem",
                    paddingInline: "var(--space-2)",
                    border: 0,
                    borderTop: active ? `2px solid ${accentToken(tab.accent)}` : "2px solid transparent",
                    borderRadius: "var(--radius-2)",
                    background: active ? "var(--gray-1)" : "var(--gray-2)",
                    color: active ? "var(--gray-12)" : "var(--gray-11)",
                    cursor: "default",
                  }}
                >
                  <button
                    onClick={() => props.onSelect(tab.tabId)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      flex: 1,
                      minWidth: 0,
                      border: 0,
                      padding: 0,
                      background: "transparent",
                      color: "inherit",
                      cursor: "default",
                    }}
                  >
                    {tab.icon ? <Text size="1">{tab.icon}</Text> : null}
                    <Text size="2" truncate style={{ minWidth: 0, flex: 1 }}>{tab.label}</Text>
                    {!active ? <TabAdornmentView adornment={adornment} /> : null}
                  </button>
                  <button
                    aria-label="Close tab"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onClose(tab.tabId);
                    }}
                    onFocus={() => setFocusedCloseTabId(tab.tabId)}
                    onBlur={() => setFocusedCloseTabId((value) => value === tab.tabId ? null : value)}
                    style={{
                      display: showClose ? "inline-flex" : "none",
                      alignItems: "center",
                      border: 0,
                      padding: 0,
                      background: "transparent",
                      color: "var(--gray-10)",
                    }}
                  >
                    <Cross2Icon width="12" height="12" />
                  </button>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Content>
                <ContextMenu.Item onSelect={() => props.onRename(tab.tabId)}>Rename</ContextMenu.Item>
                <ContextMenu.Item onSelect={() => props.onCustomize(tab.tabId)}>Set icon/color</ContextMenu.Item>
                <ContextMenu.Item onSelect={() => props.onDuplicate(tab.tabId)}>Duplicate</ContextMenu.Item>
                <ContextMenu.Item onSelect={() => props.onSaveLayout(tab.tabId)}>Save layout...</ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item onSelect={() => props.onClose(tab.tabId)}>Close</ContextMenu.Item>
                <ContextMenu.Item
                  disabled={props.tabs.length < 2}
                  onSelect={() => props.onCloseOthers(tab.tabId)}
                >
                  Close others
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Root>
          );
        })}
      </Flex>
      {overflow.length > 0 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton size="1" variant="ghost" aria-label="More tabs">
              <DotsHorizontalIcon />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {overflow.map((tab) => {
              const adornment = tabAdornment(tab, props.sessions, props.notifications);
              return (
                <DropdownMenu.Item key={tab.tabId} onSelect={() => props.onSelect(tab.tabId)}>
                  <Flex align="center" gap="2" minWidth="12rem">
                    {tab.icon ? <Text size="1">{tab.icon}</Text> : null}
                    <Text size="2" truncate style={{ flex: 1 }}>{tab.label}</Text>
                    <TabAdornmentView adornment={adornment} />
                  </Flex>
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      ) : null}
      <IconButton
        size="1"
        variant="ghost"
        aria-label={props.newTabPendingLabel ?? "New tab"}
        title={props.newTabPending ? props.newTabPendingLabel : undefined}
        onClick={props.onNewTab}
        disabled={props.newTabPending}
      >
        <PlusIcon />
      </IconButton>
      {props.newTabPending ? (
        <Text size="1" color="gray" role="status" aria-live="polite" style={{ whiteSpace: "nowrap" }}>{props.newTabPendingLabel ?? "Starting..."}</Text>
      ) : null}
      <IconButton size="1" variant="ghost" aria-label="Toggle notifications" onClick={props.onToggleNotifications}>
        <BellIcon />
      </IconButton>
    </Flex>
  );
}

function accentToken(accent?: string): string {
  return isRadixScale(accent) ? `var(--${accent}-9)` : "var(--accent-9)";
}

function isRadixScale(value?: string): boolean {
  return !!value && /^(gray|mauve|slate|sage|olive|sand|tomato|red|ruby|crimson|pink|plum|purple|violet|iris|indigo|blue|cyan|teal|jade|green|grass|brown|orange|sky|mint|lime|yellow|amber)$/.test(value);
}

function TabAdornmentView(props: { adornment: ReturnType<typeof tabAdornment> }) {
  if (!props.adornment) return null;
  if (props.adornment.kind === "badge") {
    return <Badge size="1" variant="soft" color={props.adornment.color}>{props.adornment.text}</Badge>;
  }
  return (
    <span
      aria-label={`${props.adornment.severity} session`}
      style={{
        width: "0.5rem",
        height: "0.5rem",
        borderRadius: "999px",
        background: severityColor(props.adornment.severity),
        flex: "0 0 auto",
      }}
    />
  );
}

function severityColor(severity: NotificationSeverity): string {
  if (severity === "failure") return "var(--red-9)";
  if (severity === "approval") return "var(--amber-9)";
  if (severity === "waiting") return "var(--blue-9)";
  if (severity === "done") return "var(--green-9)";
  return "var(--gray-9)";
}
