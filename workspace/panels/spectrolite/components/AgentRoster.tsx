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
  const [busy, setBusy] = useState(false);

  return (
    <Flex align="center" gap="2">
      {agents.map((agent) => (
        <Badge
          key={agent.handle}
          variant={agent.status === "live" ? "soft" : "outline"}
          color={agent.status === "live" ? "blue" : "gray"}
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
            >
              <Cross2Icon width="10" height="10" />
            </Button>
          </Flex>
        </Badge>
      ))}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button size="1" variant="soft" color="gray" disabled={disabled || busy || availableAgents.length === 0}>
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
