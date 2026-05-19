import { Button, Flex, Text } from "@radix-ui/themes";
import { PlusIcon } from "@radix-ui/react-icons";
import { agentLabel } from "./agentDetect.js";
import type { SessionInfo, TerminalTab } from "./types.js";

export function Sidebar(props: {
  tabs: TerminalTab[];
  sessions: Record<string, SessionInfo>;
  activeTabId?: string;
  onSelect(tabId: string): void;
  onNewTab(): void;
}) {
  return (
    <Flex direction="column" width="220px" p="2" gap="1" style={{ borderRight: "1px solid var(--gray-5)" }}>
      {props.tabs.map((tab) => {
        const session = props.sessions[tab.focusedSessionId];
        return (
          <button
            key={tab.tabId}
            onClick={() => props.onSelect(tab.tabId)}
            style={{
              textAlign: "left",
              border: 0,
              borderRadius: 6,
              padding: 10,
              background: props.activeTabId === tab.tabId ? "var(--accent-4)" : "transparent",
              color: "var(--gray-12)",
            }}
          >
            <Flex align="center" gap="2">
              <span style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: session?.alive === false ? "var(--red-9)" : "var(--accent-9)",
              }} />
              <Text size="2" weight="medium">{tab.label}</Text>
            </Flex>
            <Text size="1" color="gray">{agentLabel(session?.detectedAgent?.kind)} · {session?.command.cwd ?? ""}</Text>
          </button>
        );
      })}
      <Button variant="soft" onClick={props.onNewTab} mt="auto"><PlusIcon /> New tab</Button>
    </Flex>
  );
}
