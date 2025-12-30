import { useState, useCallback, useMemo } from "react";
import { Badge, DropdownMenu, Text } from "@radix-ui/themes";
import { DotFilledIcon, TriangleDownIcon } from "@radix-ui/react-icons";
import type { Participant, MethodAdvertisement } from "@natstack/agentic-messaging";
import type { ChatParticipantMetadata } from "../types";
import { MethodArgumentsModal } from "./MethodArgumentsModal";
import { schemaHasRequiredParams } from "./JsonSchemaForm";

export interface ParticipantBadgeMenuProps {
  participant: Participant<ChatParticipantMetadata>;
  hasActiveMessage: boolean;
  onCallMethod: (providerId: string, methodName: string, args: unknown) => void;
}

/**
 * Get color for participant type
 */
function getParticipantColor(type: string) {
  switch (type) {
    case "panel":
      return "blue";
    case "ai-responder":
      return "purple";
    case "claude-code":
      return "orange";
    case "codex":
      return "teal";
    default:
      return "gray";
  }
}

/**
 * Participant badge with dropdown menu showing callable methods.
 */
export function ParticipantBadgeMenu({
  participant,
  hasActiveMessage,
  onCallMethod,
}: ParticipantBadgeMenuProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<MethodAdvertisement | null>(null);

  // Get methods marked as menu items
  const menuMethods = useMemo(() => {
    const metadata = participant.metadata as ChatParticipantMetadata & { methods?: MethodAdvertisement[] };
    const allMethods = metadata.methods ?? [];
    return allMethods.filter((m) => m.menu === true);
  }, [participant.metadata]);

  const handleMethodClick = useCallback(
    (method: MethodAdvertisement) => {
      // Check if method has required parameters
      if (schemaHasRequiredParams(method.parameters)) {
        // Open modal for parameter entry
        setSelectedMethod(method);
        setModalOpen(true);
      } else {
        // Call directly with empty args
        onCallMethod(participant.id, method.name, {});
      }
    },
    [participant.id, onCallMethod]
  );

  const handleModalSubmit = useCallback(
    (args: Record<string, unknown>) => {
      if (selectedMethod) {
        onCallMethod(participant.id, selectedMethod.name, args);
      }
    },
    [participant.id, selectedMethod, onCallMethod]
  );

  const color = getParticipantColor(participant.metadata.type);
  const hasMenuItems = menuMethods.length > 0;

  // Render active indicator (pulsing dot) for agents working without menu
  const activeIndicator = hasActiveMessage && !hasMenuItems && (
    <DotFilledIcon
      style={{
        marginLeft: 4,
        width: 12,
        height: 12,
        animation: "pulse 1.5s ease-in-out infinite",
      }}
      title="Agent working"
    />
  );

  // Simple badge without dropdown when no menu items
  if (!hasMenuItems) {
    return (
      <Badge color={color}>
        @{participant.metadata.handle}
        {activeIndicator}
      </Badge>
    );
  }

  // Badge with dropdown menu when menu items exist
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Badge color={color} style={{ cursor: "pointer" }}>
            @{participant.metadata.handle}
            <TriangleDownIcon
              style={{
                marginLeft: 4,
                width: 10,
                height: 10,
                opacity: 0.6,
                ...(hasActiveMessage && {
                  animation: "pulse 1s ease-in-out infinite",
                  opacity: 1,
                }),
              }}
              title={hasActiveMessage ? "Agent working" : undefined}
            />
          </Badge>
        </DropdownMenu.Trigger>

        <DropdownMenu.Content>
          {menuMethods.map((method) => (
            <DropdownMenu.Item
              key={method.name}
              onSelect={() => handleMethodClick(method)}
            >
              {method.name}
              {method.description && (
                <Text size="1" color="gray" style={{ marginLeft: 8 }}>
                  {method.description}
                </Text>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      {selectedMethod && (
        <MethodArgumentsModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          method={selectedMethod}
          providerName={participant.metadata.name}
          onSubmit={handleModalSubmit}
        />
      )}
    </>
  );
}
