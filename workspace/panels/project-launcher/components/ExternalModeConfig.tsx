/**
 * Configuration for external folder mode.
 * Provides folder selection via bridge-backed dialog.
 */

import { useState } from "react";
import { Box, Text, TextField, Button, Flex } from "@radix-ui/themes";
import { ArchiveIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";

interface ExternalModeConfigProps {
  workingDirectory: string;
  onWorkingDirectoryChange: (dir: string) => void;
}

export function ExternalModeConfig({
  workingDirectory,
  onWorkingDirectoryChange,
}: ExternalModeConfigProps) {
  const [isSelecting, setIsSelecting] = useState(false);

  const handleChooseFolder = async () => {
    setIsSelecting(true);
    try {
      const result = await rpc.call<string | null>("main", "bridge.openFolderDialog", {
        title: "Select Project Folder",
      });
      if (result) {
        onWorkingDirectoryChange(result);
      }
    } catch (err) {
      console.error("Failed to open folder dialog:", err);
    } finally {
      setIsSelecting(false);
    }
  };

  return (
    <Box>
      <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Working Directory
      </Text>

      <Flex gap="2" align="end">
        <Box style={{ flex: 1 }}>
          <TextField.Root
            value={workingDirectory}
            onChange={(e) => onWorkingDirectoryChange(e.target.value)}
            placeholder="/path/to/your/project"
          >
            <TextField.Slot>
              <ArchiveIcon height="16" width="16" />
            </TextField.Slot>
            {workingDirectory && (
              <TextField.Slot>
                <CheckCircledIcon height="16" width="16" color="var(--green-9)" />
              </TextField.Slot>
            )}
          </TextField.Root>
        </Box>

        <Button variant="soft" onClick={handleChooseFolder} disabled={isSelecting}>
          {isSelecting ? "Selecting..." : "Choose Folder"}
        </Button>
      </Flex>

      {workingDirectory && (
        <Text size="1" color="gray" mt="1">
          Agent will have access to files in this directory
        </Text>
      )}
    </Box>
  );
}
