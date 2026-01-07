import { Box, Flex, Text, Badge } from "@radix-ui/themes";
import type { FileDiff } from "./types";
import { ImageCompare } from "./ImageCompare";

interface BinaryFileDiffProps {
  diff: FileDiff;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value.toFixed(1)} ${unit}`;
}

export function BinaryFileDiff({ diff }: BinaryFileDiffProps) {
  const info = diff.binaryInfo;
  const image = diff.imageDiff;
  const sizeDeltaText =
    info && (info.sizeDelta >= 0 ? `+${formatBytes(info.sizeDelta)}` : formatBytes(info.sizeDelta));

  return (
    <Box p="3">
      <Flex align="center" gap="2" wrap="wrap">
        <Badge size="1" variant="soft">
          Binary
        </Badge>
        {info?.mimeType && (
          <Badge size="1" variant="outline">
            {info.mimeType}
          </Badge>
        )}
        {info && (
          <Text size="1" color="gray">
            {formatBytes(info.oldSize)} {"->"} {formatBytes(info.newSize)} ({sizeDeltaText})
          </Text>
        )}
      </Flex>

      {info?.isImage && image && (
        <Box mt="3">
          <ImageCompare
            oldDataUrl={image.oldDataUrl}
            newDataUrl={image.newDataUrl}
            oldLabel={image.oldDimensions ? `Before (${image.oldDimensions.width}x${image.oldDimensions.height})` : "Before"}
            newLabel={image.newDimensions ? `After (${image.newDimensions.width}x${image.newDimensions.height})` : "After"}
          />
        </Box>
      )}

      {!info?.isImage && (
        <Box mt="2">
          <Text size="2" color="gray">
            Preview unavailable for binary content.
          </Text>
        </Box>
      )}
    </Box>
  );
}
