import React, { useRef } from "react";
import { Badge, Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import type { Participant } from "@natstack/pubsub";
import type { ToolApprovalProps } from "@workspace/tool-ui";
import { useChatContext } from "../context/ChatContext";
import type { ChatParticipantMetadata, PendingAgent } from "../types";
import { ParticipantBadgeMenu } from "./ParticipantBadgeMenu";
import { PendingAgentBadge } from "./PendingAgentBadge";
import { ToolPermissionsDropdown } from "./ToolPermissionsDropdown";

const NOOP = () => {};

/** Shallow-compare two Maps by entry value (used for small maps like activeStatus). */
function mapsShallowEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    if (b.get(key) !== val) return false;
  }
  return true;
}

/**
 * Chat header bar with connection status, participant badges, and actions.
 * Reads all data from ChatContext.
 *
 * The participantActiveStatus is stabilised with a ref — the previous Map
 * reference is returned when the values haven't changed so that the inner
 * React.memo boundary isn't defeated during streaming (messages changes
 * every frame but active-status rarely flips).
 */
export function ChatHeader() {
  const {
    channelId,
    connected,
    status,
    sessionEnabled,
    messages,
    participants,
    pendingAgents,
    toolApproval,
    onCallMethod,
    onDebugConsoleChange,
    onAddAgent,
    availableAgents,
    onRemoveAgent,
  } = useChatContext();

  // Memoize participant active status: single reverse scan instead of O(P*M) filter per render.
  // Stabilised with a ref — return the previous Map reference when the values haven't
  // changed so that ChatHeaderInner's React.memo boundary isn't defeated during streaming.
  const prevActiveStatusRef = useRef<Map<string, boolean>>(new Map());
  const participantActiveStatus = React.useMemo(() => {
    const statusMap = new Map<string, boolean>();
    const pIds = new Set(Object.keys(participants));
    const found = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && found.size < pIds.size; i--) {
      const msg = messages[i]!;
      if (msg.kind !== "message" || !pIds.has(msg.senderId) || found.has(msg.senderId)) continue;
      statusMap.set(msg.senderId, !msg.complete && !msg.error);
      found.add(msg.senderId);
    }

    // Return previous reference if values are identical (avoids breaking memo)
    const prev = prevActiveStatusRef.current;
    if (mapsShallowEqual(prev, statusMap)) return prev;
    prevActiveStatusRef.current = statusMap;
    return statusMap;
  }, [messages, participants]);

  return (
    <ChatHeaderInner
      channelId={channelId}
      connected={connected}
      status={status}
      sessionEnabled={sessionEnabled}
      participants={participants}
      participantActiveStatus={participantActiveStatus}
      pendingAgents={pendingAgents}
      onCallMethod={onCallMethod}
      toolApproval={toolApproval}
      onAddAgent={onAddAgent}
      availableAgents={availableAgents}
      onRemoveAgent={onRemoveAgent}
      onDebugConsoleChange={onDebugConsoleChange}
    />
  );
}

// ---------- Memoized inner component ----------

interface ChatHeaderInnerProps {
  channelId: string | null;
  connected: boolean;
  status: string;
  sessionEnabled?: boolean;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  participantActiveStatus: Map<string, boolean>;
  pendingAgents: Map<string, PendingAgent>;
  onCallMethod?: (providerId: string, methodName: string, args: unknown) => void;
  toolApproval?: ToolApprovalProps;
  onAddAgent?: (agentId?: string) => void;
  availableAgents?: Array<{ id: string; name: string; proposedHandle: string }>;
  onRemoveAgent?: (handle: string) => void;
  onDebugConsoleChange?: (agentHandle: string | null) => void;
}

function chatHeaderInnerPropsEqual(prev: ChatHeaderInnerProps, next: ChatHeaderInnerProps): boolean {
  return (
    prev.channelId === next.channelId &&
    prev.connected === next.connected &&
    prev.status === next.status &&
    prev.sessionEnabled === next.sessionEnabled &&
    prev.participants === next.participants &&
    prev.pendingAgents === next.pendingAgents &&
    prev.onCallMethod === next.onCallMethod &&
    prev.toolApproval === next.toolApproval &&
    prev.onAddAgent === next.onAddAgent &&
    prev.availableAgents === next.availableAgents &&
    prev.onRemoveAgent === next.onRemoveAgent &&
    prev.onDebugConsoleChange === next.onDebugConsoleChange &&
    mapsShallowEqual(prev.participantActiveStatus, next.participantActiveStatus)
  );
}

const ChatHeaderInner = React.memo(function ChatHeaderInner({
  channelId,
  connected,
  status,
  sessionEnabled,
  participants,
  participantActiveStatus,
  pendingAgents,
  onCallMethod,
  toolApproval,
  onAddAgent,
  availableAgents,
  onRemoveAgent,
  onDebugConsoleChange,
}: ChatHeaderInnerProps) {
  return (
    <Flex justify="between" align="center" flexShrink="0">
      <Flex gap="2" align="center">
        <Text size="5" weight="bold">
          Agentic Chat
        </Text>
        <Badge color="gray">{channelId}</Badge>
        <Badge color={sessionEnabled ? "blue" : "orange"} title={sessionEnabled ? "Session persistence enabled - messages are saved and can be replayed" : "Ephemeral session - messages are not persisted"}>
          {sessionEnabled ? "Session" : "Ephemeral"}
        </Badge>
      </Flex>
      <Flex gap="2" align="center">
        <Badge color={connected ? "green" : "gray"}>{connected ? "Connected" : status}</Badge>
        {Object.values(participants).map((p) => {
          const hasActive = participantActiveStatus.get(p.id) ?? false;

          return (
            <ParticipantBadgeMenu
              key={p.id}
              participant={p}
              hasActiveMessage={hasActive}
              onCallMethod={onCallMethod ?? NOOP}
              onRemoveAgent={onRemoveAgent}
              onOpenDebugConsole={onDebugConsoleChange ?? undefined}
            />
          );
        })}
        {/* Pending/failed agents not yet in roster */}
        {pendingAgents && Array.from(pendingAgents.entries()).map(([handle, info]) => (
          <PendingAgentBadge
            key={`pending-${handle}`}
            handle={handle}
            agentId={info.agentId}
            status={info.status}
            error={info.error}
            onOpenDebugConsole={onDebugConsoleChange ?? undefined}
          />
        ))}
        {onAddAgent && availableAgents && availableAgents.length > 0 ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button variant="soft" size="1">Add Agent</Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {availableAgents.map((agent) => (
                <DropdownMenu.Item key={agent.id} onSelect={() => onAddAgent(agent.id)}>
                  {agent.name}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        ) : onAddAgent ? (
          <Button variant="soft" size="1" onClick={() => onAddAgent()}>
            Add Agent
          </Button>
        ) : null}
        {toolApproval && (
          <ToolPermissionsDropdown
            settings={toolApproval.settings}
            onSetFloor={toolApproval.onSetFloor}
          />
        )}
      </Flex>
    </Flex>
  );
}, chatHeaderInnerPropsEqual);
