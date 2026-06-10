import { createPortal } from "react-dom";
import { Box, Flex, Text } from "@radix-ui/themes";
import type { MentionCandidate } from "../hooks/useMentionAutocomplete";

const POPOVER_WIDTH = 260;

interface MentionAutocompleteProps {
  candidates: MentionCandidate[];
  selectedIndex: number;
  /** Viewport coordinates of the @ trigger (see useMentionAutocomplete). */
  position: { left: number; top: number } | null;
  onSelect: (candidate: MentionCandidate) => void;
  onHighlight: (index: number) => void;
}

export function MentionAutocomplete({
  candidates,
  selectedIndex,
  position,
  onSelect,
  onHighlight,
}: MentionAutocompleteProps) {
  // Portal + fixed positioning: the input lives inside several
  // overflow-clipping surfaces (chat root, input card); rendering in-place
  // gets the popover cut off at the message-box edge.
  return createPortal(
    <Box
      style={{
        position: "fixed",
        left: position
          ? Math.min(Math.max(4, position.left), window.innerWidth - POPOVER_WIDTH - 8)
          : 12,
        top: position ? Math.max(8, position.top - 6) : 0,
        transform: "translateY(-100%)",
        zIndex: 1000,
        width: POPOVER_WIDTH,
        maxWidth: "calc(100vw - 32px)",
        border: "1px solid var(--gray-a6)",
        borderRadius: 8,
        background: "var(--color-panel-solid)",
        boxShadow: "var(--shadow-4)",
        overflow: "hidden",
      }}
    >
      {candidates.map((candidate, index) => (
        <Flex
          key={candidate.participantId}
          align="center"
          justify="between"
          gap="2"
          px="3"
          py="2"
          style={{
            cursor: "pointer",
            background: index === selectedIndex ? "var(--accent-a4)" : "transparent",
          }}
          onMouseEnter={() => onHighlight(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(candidate);
          }}
        >
          <Box style={{ minWidth: 0 }}>
            <Text size="2" weight="medium" truncate>
              {candidate.name}
            </Text>
            <Text as="div" size="1" color="gray" truncate>
              @{candidate.handle}
            </Text>
          </Box>
          <Text size="1" color="gray">
            {candidate.type}
          </Text>
        </Flex>
      ))}
    </Box>,
    document.body
  );
}
