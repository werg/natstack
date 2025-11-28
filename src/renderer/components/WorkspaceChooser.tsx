import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Box, Button, Card, Flex, Heading, IconButton, Separator, Text } from "@radix-ui/themes";
import { Cross2Icon, FileIcon, GearIcon, PlusIcon } from "@radix-ui/react-icons";

import {
  recentWorkspacesAtom,
  workspacesLoadingAtom,
  loadRecentWorkspacesAtom,
  removeRecentWorkspaceAtom,
  selectWorkspaceAtom,
  settingsDialogOpenAtom,
  wizardDialogOpenAtom,
  wizardFormDataAtom,
} from "../state/appModeAtoms";
import type { RecentWorkspace } from "../../shared/ipc/types";

export function WorkspaceChooser() {
  const recentWorkspaces = useAtomValue(recentWorkspacesAtom);
  const isLoading = useAtomValue(workspacesLoadingAtom);
  const loadRecentWorkspaces = useSetAtom(loadRecentWorkspacesAtom);
  const removeRecentWorkspace = useSetAtom(removeRecentWorkspaceAtom);
  const selectWorkspace = useSetAtom(selectWorkspaceAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setWizardDialogOpen = useSetAtom(wizardDialogOpenAtom);
  const setWizardFormData = useSetAtom(wizardFormDataAtom);

  // Load recent workspaces on mount
  useEffect(() => {
    void loadRecentWorkspaces();
  }, [loadRecentWorkspaces]);

  const handleOpenFolder = async () => {
    try {
      const folderPath = await window.electronAPI.openFolderDialog();
      if (!folderPath) return;

      // Validate the selected folder
      const validation = await window.electronAPI.validateWorkspacePath(folderPath);

      if (validation.hasConfig) {
        // Valid workspace - open it directly
        await selectWorkspace(validation.path);
      } else {
        // No config - open wizard with pre-filled path
        setWizardFormData({
          folderPath: validation.path,
          workspaceName: validation.name,
        });
        setWizardDialogOpen(true);
      }
    } catch (error) {
      console.error("Failed to open folder:", error);
    }
  };

  const handleSelectWorkspace = async (workspace: RecentWorkspace) => {
    try {
      await selectWorkspace(workspace.path);
    } catch (error) {
      console.error("Failed to select workspace:", error);
    }
  };

  const handleRemoveWorkspace = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    await removeRecentWorkspace(path);
  };

  const handleCreateNew = () => {
    setWizardFormData({
      folderPath: "",
      workspaceName: "",
    });
    setWizardDialogOpen(true);
  };

  const handleOpenSettings = () => {
    setSettingsDialogOpen(true);
  };

  // Format path for display (shorten home directory)
  // Note: In Electron renderer with contextIsolation, we can't access process.env
  // So we just try common home directory patterns
  const formatPath = (filePath: string): string => {
    // Try to detect home directory from path patterns
    const homePatterns = [
      /^\/home\/[^/]+/, // Linux
      /^\/Users\/[^/]+/, // macOS
      /^[A-Z]:\\Users\\[^\\]+/i, // Windows
    ];
    for (const pattern of homePatterns) {
      const match = filePath.match(pattern);
      if (match) {
        return "~" + filePath.slice(match[0].length);
      }
    }
    return filePath;
  };

  return (
    <Box
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "24px",
        paddingTop: "40px", // Account for title bar
      }}
    >
      {/* Header */}
      <Flex direction="column" align="center" gap="2" mb="5">
        <Heading size="7" weight="bold">
          NatStack
        </Heading>
        <Text size="2" color="gray">
          Select a workspace to get started
        </Text>
      </Flex>

      {/* Recent Workspaces */}
      <Card style={{ flex: 1, overflow: "hidden" }}>
        <Flex direction="column" style={{ height: "100%" }}>
          <Flex justify="between" align="center" mb="3">
            <Text size="2" weight="medium" color="gray">
              Recent Workspaces
            </Text>
            {isLoading && (
              <Text size="1" color="gray">
                Loading...
              </Text>
            )}
          </Flex>

          <Box
            style={{
              flex: 1,
              overflow: "auto",
              marginRight: "-8px",
              paddingRight: "8px",
            }}
          >
            {recentWorkspaces.length === 0 ? (
              <Flex align="center" justify="center" style={{ height: "100%", minHeight: "120px" }}>
                <Text size="2" color="gray">
                  No recent workspaces
                </Text>
              </Flex>
            ) : (
              <Flex direction="column" gap="2">
                {recentWorkspaces.map((workspace) => (
                  <WorkspaceItem
                    key={workspace.path}
                    workspace={workspace}
                    formatPath={formatPath}
                    onSelect={() => handleSelectWorkspace(workspace)}
                    onRemove={(e) => handleRemoveWorkspace(e, workspace.path)}
                  />
                ))}
              </Flex>
            )}
          </Box>
        </Flex>
      </Card>

      {/* Action Buttons */}
      <Flex gap="3" mt="4" justify="center">
        <Button variant="soft" size="3" onClick={handleOpenFolder}>
          <FileIcon />
          Open Folder...
        </Button>
        <Button variant="soft" size="3" color="green" onClick={handleCreateNew}>
          <PlusIcon />
          Create New Workspace
        </Button>
      </Flex>

      {/* Settings */}
      <Separator size="4" my="4" />

      <Flex justify="center">
        <Button variant="ghost" size="2" onClick={handleOpenSettings}>
          <GearIcon />
          Settings
        </Button>
      </Flex>
    </Box>
  );
}

interface WorkspaceItemProps {
  workspace: RecentWorkspace;
  formatPath: (path: string) => string;
  onSelect: () => void;
  onRemove: (e: React.MouseEvent) => void;
}

function WorkspaceItem({ workspace, formatPath, onSelect, onRemove }: WorkspaceItemProps) {
  return (
    <Card asChild style={{ cursor: "pointer" }} className="workspace-item">
      <button
        onClick={onSelect}
        style={{
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: 0,
        }}
      >
        <Flex justify="between" align="center" p="3">
          <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
            <Text size="2" weight="medium" truncate>
              {workspace.name}
            </Text>
            <Text size="1" color="gray" truncate style={{ fontFamily: "var(--font-mono)" }}>
              {formatPath(workspace.path)}
            </Text>
          </Flex>
          <IconButton
            variant="ghost"
            size="1"
            color="gray"
            onClick={onRemove}
            style={{ flexShrink: 0 }}
          >
            <Cross2Icon />
          </IconButton>
        </Flex>
      </button>
    </Card>
  );
}
