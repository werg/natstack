import { Box, Flex, Text, Button, Card } from "@radix-ui/themes";
import { FileDiffHeader } from "./FileDiffHeader";
import type { FileChange, FileDiff } from "./types";

interface LargeDiffGuardProps {
  file: FileChange;
  diff: FileDiff;
  onExpand: () => void;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onDiscardFile?: (path: string) => void;
}

export function LargeDiffGuard({
  file,
  diff,
  onExpand,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
}: LargeDiffGuardProps) {
  const lineCount = diff.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.length,
    0
  );
  const stats = diff.hunks.reduce(
    (acc, hunk) => {
      for (const line of hunk.lines) {
        if (line.type === "add") acc.additions++;
        if (line.type === "delete") acc.deletions++;
      }
      return acc;
    },
    { additions: 0, deletions: 0 }
  );

  return (
    <Card size="2">
      <FileDiffHeader
        file={file}
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile}
        stats={stats}
      />

      <Flex direction="column" align="center" justify="center" p="6" gap="3">
        <Text color="gray">
          Large diff: {lineCount.toLocaleString()} lines changed
        </Text>
        <Button variant="soft" onClick={onExpand}>
          Show full diff
        </Button>
      </Flex>
    </Card>
  );
}
