import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flex, Spinner, Text } from "@radix-ui/themes";
import { useConflicts } from "./hooks/useConflicts";
import { ThreeWayMergeEditor } from "./ThreeWayMergeEditor";

interface ConflictResolutionViewProps {
  theme?: "light" | "dark";
}

export function ConflictResolutionView({ theme }: ConflictResolutionViewProps) {
  const { conflicts, loading, resolving, error, resolve } = useConflicts();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (conflicts.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !conflicts.find((conflict) => conflict.path === selectedPath)) {
      setSelectedPath(conflicts[0]?.path ?? null);
    }
  }, [conflicts, selectedPath]);

  const selectedConflict = useMemo(
    () => conflicts.find((conflict) => conflict.path === selectedPath) ?? null,
    [conflicts, selectedPath]
  );

  const currentIndex = conflicts.findIndex((c) => c.path === selectedPath);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < conflicts.length - 1;

  if (loading) {
    return (
      <Flex align="center" justify="center" py="4">
        <Spinner size="2" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Box p="3">
        <Text size="2" color="red">
          {error.message}
        </Text>
      </Box>
    );
  }

  if (conflicts.length === 0) {
    return (
      <Box p="3">
        <Text size="2" color="gray">No conflicts detected</Text>
      </Box>
    );
  }

  return (
    <Flex gap="3" align="start" wrap="wrap">
      <Box style={{ minWidth: 220 }}>
        <Flex direction="column" gap="2">
          {conflicts.map((conflict) => {
            const isSelected = conflict.path === selectedPath;
            const markerCount = conflict.markers.length;
            return (
              <Button
                key={conflict.path}
                variant={isSelected ? "solid" : "soft"}
                onClick={() => setSelectedPath(conflict.path)}
                style={{ justifyContent: "space-between" }}
              >
                <Flex align="center" justify="between" style={{ width: "100%" }}>
                  <Text size="2" weight={isSelected ? "medium" : undefined}>
                    {conflict.path}
                  </Text>
                  <Text size="1" color="gray">
                    {markerCount} marker{markerCount === 1 ? "" : "s"}
                  </Text>
                </Flex>
              </Button>
            );
          })}
        </Flex>
      </Box>

      <Box style={{ flex: 1, minWidth: 280 }}>
        {selectedConflict && (
          <>
            {/* Navigation between conflicts */}
            {conflicts.length > 1 && (
              <Flex gap="2" align="center" mb="3">
                <Button
                  size="1"
                  variant="soft"
                  disabled={!hasPrev}
                  onClick={() => {
                    const prevPath = conflicts[currentIndex - 1]?.path;
                    if (prevPath) setSelectedPath(prevPath);
                  }}
                >
                  Previous
                </Button>
                <Text size="2" color="gray">
                  {currentIndex + 1} / {conflicts.length}
                </Text>
                <Button
                  size="1"
                  variant="soft"
                  disabled={!hasNext}
                  onClick={() => {
                    const nextPath = conflicts[currentIndex + 1]?.path;
                    if (nextPath) setSelectedPath(nextPath);
                  }}
                >
                  Next
                </Button>
              </Flex>
            )}
            {resolving && (
              <Flex align="center" gap="2" mb="2">
                <Spinner size="1" />
                <Text size="2" color="gray">Resolving conflict...</Text>
              </Flex>
            )}
            <ThreeWayMergeEditor
              conflict={selectedConflict}
              theme={theme}
              onResolve={async (content) => {
                await resolve({ path: selectedConflict.path, content });
              }}
              disabled={resolving}
            />
          </>
        )}
      </Box>
    </Flex>
  );
}
