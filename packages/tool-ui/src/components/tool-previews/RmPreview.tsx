/**
 * RmPreview - Warning card for rm (delete) tool approvals
 *
 * Shows the path being deleted with danger styling.
 * Extra warning for recursive deletes.
 */

import { Text, Flex, Callout } from "@radix-ui/themes";
import { TrashIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";

export interface RmPreviewProps {
  path: string;
  recursive?: boolean;
}

function getShortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 4) return filePath;
  return ".../" + parts.slice(-4).join("/");
}

export function RmPreview({ path, recursive }: RmPreviewProps) {
  const shortPath = getShortPath(path);

  if (recursive) {
    return (
      <Callout.Root color="red" size="2">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>
          <Flex direction="column" gap="1">
            <Text weight="medium">Delete directory recursively:</Text>
            <Text style={{ fontFamily: "monospace" }} title={path}>
              {shortPath}
            </Text>
            <Text size="1" color="red">
              This will delete all contents!
            </Text>
          </Flex>
        </Callout.Text>
      </Callout.Root>
    );
  }

  return (
    <Callout.Root color="red" size="2">
      <Callout.Icon>
        <TrashIcon />
      </Callout.Icon>
      <Callout.Text>
        <Flex gap="2" align="center">
          <Text weight="medium">Delete:</Text>
          <Text style={{ fontFamily: "monospace" }} title={path}>
            {shortPath}
          </Text>
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}
