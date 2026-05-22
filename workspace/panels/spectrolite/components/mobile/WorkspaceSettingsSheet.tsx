/**
 * Mobile workspace settings sheet.
 *
 * Replaces the nested DropdownMenu in the mobile header — nested
 * Radix dropdowns are awkward on touch and don't always render
 * correctly above the virtual keyboard. A bottom sheet gives each
 * sub-panel (branch, agents, vault) the room it needs and a real
 * tappable surface.
 *
 * Layout: vertical sections, each a tap-friendly card. The first
 * row is the vault label + "Switch" button; below it the branch
 * picker; then the agent roster (as a vertical list so + and − are
 * full-width touch targets).
 */

import { Box, Button, Flex, Heading, Separator, Text } from "@radix-ui/themes";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { BottomSheet } from "./BottomSheet";
import { BranchPicker } from "../BranchPicker";
import { AgentRoster, type RosterAgent } from "../AgentRoster";
import type { AgentVaultNotice } from "../Workspace";
import type { AvailableAgent } from "../../bootstrap";

export interface WorkspaceSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  refreshNonce: number;
  onSwitchVault: () => void;
  roster: RosterAgent[];
  availableAgents: AvailableAgent[];
  onAddAgent: (agentId: string) => void | Promise<void>;
  onRemoveAgent: (handle: string) => void | Promise<void>;
  agentVaultNotice?: AgentVaultNotice | null;
}

export function WorkspaceSettingsSheet({
  open,
  onOpenChange,
  repoRoot,
  refreshNonce,
  onSwitchVault,
  roster,
  availableAgents,
  onAddAgent,
  onRemoveAgent,
  agentVaultNotice,
}: WorkspaceSettingsSheetProps) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Workspace">
      <Flex direction="column" gap="4">
        <Section title="Vault">
          <Button
            size="3"
            variant="soft"
            color="gray"
            onClick={() => { onSwitchVault(); onOpenChange(false); }}
            style={{ justifyContent: "space-between", width: "100%", minHeight: 48 }}
          >
            <Flex direction="column" align="start" style={{ flex: 1, textAlign: "left" }}>
              <Text size="2" weight="medium">{repoRoot.replace(/^\//, "")}</Text>
              <Text size="1" color="gray">Tap to switch</Text>
            </Flex>
            <ChevronRightIcon />
          </Button>
        </Section>

        <Separator size="4" />

        <Section title="Branch">
          <BranchPicker repoRoot={repoRoot} refreshNonce={refreshNonce} />
        </Section>

        <Separator size="4" />

        <Section title={`Agents (${roster.length})`}>
          {agentVaultNotice ? (
            <Text
              size="1"
              color={agentVaultNotice.state === "failed" ? "red" : agentVaultNotice.state === "pending" ? "amber" : "gray"}
              data-testid="spectrolite-agent-vault-status"
            >
              {agentVaultNotice.state === "pending"
                ? `Updating agents for ${agentVaultNotice.repoRoot.replace(/^\//, "")}`
                : agentVaultNotice.state === "failed"
                  ? `Agent vault update failed for ${agentVaultNotice.repoRoot.replace(/^\//, "")}`
                  : `Agents using ${agentVaultNotice.repoRoot.replace(/^\//, "")}`}
            </Text>
          ) : null}
          <AgentRoster
            agents={roster}
            availableAgents={availableAgents}
            onAdd={async (id) => { await onAddAgent(id); }}
            onRemove={async (handle) => { await onRemoveAgent(handle); }}
          />
        </Section>
      </Flex>
    </BottomSheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Flex direction="column" gap="2">
      <Heading size="2" color="gray" style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {title}
      </Heading>
      <Box>{children}</Box>
    </Flex>
  );
}
