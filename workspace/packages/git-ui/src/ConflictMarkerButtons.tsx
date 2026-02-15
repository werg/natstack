import { Flex, Button, Text } from "@radix-ui/themes";
import type { ConflictMarker } from "@natstack/git";

interface ConflictMarkerButtonsProps {
  index: number;
  marker?: ConflictMarker;
  onSelect: (choice: "ours" | "theirs" | "both") => void;
}

export function ConflictMarkerButtons({ index, marker, onSelect }: ConflictMarkerButtonsProps) {
  const label = marker
    ? `Conflict ${index + 1} (lines ${marker.startLine}-${marker.endLine})`
    : `Conflict ${index + 1}`;

  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Text size="1" color="gray">
        {label}
      </Text>
      <Button size="1" variant="soft" onClick={() => onSelect("ours")}>Ours</Button>
      <Button size="1" variant="soft" onClick={() => onSelect("theirs")}>Theirs</Button>
      <Button size="1" variant="soft" onClick={() => onSelect("both")}>Both</Button>
    </Flex>
  );
}
