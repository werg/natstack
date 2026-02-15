import { Flex, Text, Button, Checkbox } from "@radix-ui/themes";
import type { Hunk } from "./types";

interface HunkHeaderProps {
  hunk: Hunk;
  selected: boolean;
  indeterminate: boolean;
  additions: number;
  deletions: number;
  onToggle: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
}

export function HunkHeader({
  hunk,
  selected,
  indeterminate,
  additions,
  deletions,
  onToggle,
  onStage,
  onUnstage,
}: HunkHeaderProps) {
  return (
    <Flex align="center" justify="between" gap="2" p="2">
      <Flex align="center" gap="2">
        <Checkbox checked={selected ? true : indeterminate ? "indeterminate" : false} onCheckedChange={onToggle} />
        <Text size="1" color="gray">
          {hunk.header}
        </Text>
        <Text size="1" color="gray">+{additions}</Text>
        <Text size="1" color="gray">-{deletions}</Text>
      </Flex>
      <Flex gap="1">
        {onStage && (
          <Button size="1" variant="soft" onClick={onStage}>
            Stage
          </Button>
        )}
        {onUnstage && (
          <Button size="1" variant="soft" onClick={onUnstage}>
            Unstage
          </Button>
        )}
      </Flex>
    </Flex>
  );
}
