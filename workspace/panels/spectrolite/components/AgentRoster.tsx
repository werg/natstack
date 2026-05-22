/**
 * Compact strip of resident agents with add/remove controls.
 *
 * Stays minimal — Spectrolite isn't a chat surface. The strip lives at the
 * top-right corner of the editor and only expands when the user clicks
 * "Add agent".
 */

import { useState } from "react";
import { Badge, Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { PersonIcon, PlusIcon, Cross2Icon } from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
import type { AvailableAgent } from "../bootstrap";

export interface RosterAgent {
  handle: string;
  participantId?: string;
  status: "live" | "pending";
}

export interface AgentRosterProps {
  agents: RosterAgent[];
  availableAgents: AvailableAgent[];
  onAdd: (agentId: string) => void | Promise<void>;
  onRemove: (handle: string) => void | Promise<void>;
  disabled?: boolean;
}

export function AgentRoster({ agents, availableAgents, onAdd, onRemove, disabled }: AgentRosterProps) {
  const isMobile = useIsMobile();
  const [busy, setBusy] = useState(false);

  // On mobile, stack agents vertically with full-width rows; the
  // horizontal-strip layout (designed for the desktop header) becomes
  // unreadable on narrow screens.
  if (isMobile) {
    return (
      <Flex direction="column" gap="2">
        {agents.map((agent) => (
          <Flex
            key={agent.handle}
            data-testid={`spectrolite-agent-${agent.handle}`}
            align="center"
            justify="between"
            gap="2"
            px="2"
            style={{
              minHeight: 48,
              border: "1px solid var(--gray-5)",
              borderRadius: "var(--radius-2)",
              background: agent.status === "live" ? "var(--blue-2)" : "var(--gray-2)",
            }}
          >
            <Flex align="center" gap="2">
              <PersonIcon />
              <Text size="2" weight="medium">@{agent.handle}</Text>
              {agent.status !== "live" ? <Text size="1" color="gray">pending</Text> : null}
            </Flex>
            <Button
              size="2"
              variant="ghost"
              color="gray"
              disabled={disabled || busy}
              onClick={async () => {
                setBusy(true);
                try { await onRemove(agent.handle); } finally { setBusy(false); }
              }}
              aria-label={`Remove @${agent.handle}`}
              data-testid={`spectrolite-agent-remove-${agent.handle}`}
              style={{ minHeight: 40, minWidth: 40 }}
            >
              <Cross2Icon />
            </Button>
          </Flex>
        ))}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button
              size="3"
              variant="soft"
              color="gray"
              disabled={disabled || busy || availableAgents.length === 0}
              style={{ minHeight: 48 }}
              data-testid="spectrolite-agent-add-trigger"
            >
              <PlusIcon /> Add agent
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {availableAgents.length === 0 ? (
              <DropdownMenu.Item disabled>(no agents available)</DropdownMenu.Item>
            ) : (
              availableAgents.map((a) => (
                <DropdownMenu.Item
                  key={`${a.id}-${a.className}`}
                  data-testid={`spectrolite-agent-option-${a.className}`}
                  onSelect={async () => {
                    setBusy(true);
                    try { await onAdd(a.id); } finally { setBusy(false); }
                  }}
                >
                  {a.name} <Text color="gray" size="1">({a.className})</Text>
                </DropdownMenu.Item>
              ))
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Flex>
    );
  }

  return (
    <Flex align="center" gap="2">
      {agents.map((agent) => (
        <Badge
          key={agent.handle}
          variant={agent.status === "live" ? "soft" : "outline"}
          color={agent.status === "live" ? "blue" : "gray"}
          data-testid={`spectrolite-agent-${agent.handle}`}
        >
          <Flex align="center" gap="1">
            <PersonIcon />
            <Text size="1">@{agent.handle}</Text>
            <Button
              size="1"
              variant="ghost"
              color="gray"
              disabled={disabled || busy}
              onClick={async () => {
                setBusy(true);
                try { await onRemove(agent.handle); } finally { setBusy(false); }
              }}
              aria-label={`Remove @${agent.handle}`}
              data-testid={`spectrolite-agent-remove-${agent.handle}`}
            >
              <Cross2Icon width="10" height="10" />
            </Button>
          </Flex>
        </Badge>
      ))}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button
            size="1"
            variant="soft"
            color="gray"
            disabled={disabled || busy || availableAgents.length === 0}
            data-testid="spectrolite-agent-add-trigger"
          >
            <PlusIcon /> Agent
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {availableAgents.length === 0 ? (
            <DropdownMenu.Item disabled>(no agents available)</DropdownMenu.Item>
          ) : (
            availableAgents.map((a) => (
              <DropdownMenu.Item
                key={`${a.id}-${a.className}`}
                data-testid={`spectrolite-agent-option-${a.className}`}
                onSelect={async () => {
                  setBusy(true);
                  try { await onAdd(a.id); } finally { setBusy(false); }
                }}
              >
                {a.name} <Text color="gray" size="1">({a.className})</Text>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </Flex>
  );
}
