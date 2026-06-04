import { Box, Flex, Text } from "@radix-ui/themes";
import type { MentionCandidate } from "../hooks/useMentionAutocomplete";

interface MentionAutocompleteProps {
  candidates: MentionCandidate[];
  selectedIndex: number;
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
  return (
    <Box
      style={{
        position: "absolute",
        left: position ? Math.max(4, position.left) : 12,
        top: position ? Math.max(0, position.top - 6) : 0,
        transform: "translateY(-100%)",
        zIndex: 1000,
        width: 260,
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
    </Box>
  );
}
