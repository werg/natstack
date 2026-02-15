import { Box, Flex, Text, Progress } from "@radix-ui/themes";
import type { GitProgress } from "@natstack/git";

export interface PushPullProgressProps {
  progress: GitProgress;
}

export function PushPullProgress({ progress }: PushPullProgressProps) {
  const percent = progress.total > 0 ? Math.min(100, (progress.loaded / progress.total) * 100) : null;
  // Use indeterminate progress (no value) when total is unknown
  const isIndeterminate = percent === null;

  return (
    <Box mt="2">
      <Flex align="center" justify="between" mb="1">
        <Text size="1" color="gray">{progress.phase}</Text>
        {percent !== null && (
          <Text size="1" color="gray">{Math.round(percent)}%</Text>
        )}
      </Flex>
      {isIndeterminate ? (
        <Progress size="1" />
      ) : (
        <Progress size="1" value={percent} />
      )}
    </Box>
  );
}
