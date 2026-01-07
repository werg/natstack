import { Box, Checkbox, Code, Flex, Text } from "@radix-ui/themes";
import type { Hunk } from "./types";

interface LineSelectionOverlayProps {
  hunk: Hunk;
  hunkIndex: number;
  selectedLines?: Set<number> | null;
  onToggleLine: (hunkIndex: number, lineIndex: number) => void;
}

export function LineSelectionOverlay({ hunk, hunkIndex, selectedLines, onToggleLine }: LineSelectionOverlayProps) {
  return (
    <Box px="3" py="1">
      {hunk.lines.map((line, lineIndex) => {
        const isChange = line.type === "add" || line.type === "delete";
        const checked = selectedLines === null ? isChange : selectedLines?.has(lineIndex) ?? false;
        const lineLabel = line.type === "add" ? "+" : line.type === "delete" ? "-" : " ";
        const numberLabel = line.type === "add" ? line.newLineNo : line.type === "delete" ? line.oldLineNo : line.newLineNo;
        // Stable key from line type and line numbers (unique within a hunk)
        const lineKey = `${line.type}:${line.oldLineNo ?? "-"}:${line.newLineNo ?? "-"}`;

        return (
          <Flex key={lineKey} align="center" gap="2" py="1">
            {isChange ? (
              <Checkbox
                checked={checked}
                onCheckedChange={() => onToggleLine(hunkIndex, lineIndex)}
              />
            ) : (
              <Box width="16px" />
            )}
            <Box width="36px" flexShrink="0">
              <Text size="1" color="gray" align="right">
                {numberLabel ?? ""}
              </Text>
            </Box>
            <Code size="1" variant="ghost">
              {lineLabel} {line.content || ""}
            </Code>
          </Flex>
        );
      })}
    </Box>
  );
}
