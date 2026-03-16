import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Box, Button, Card, Flex, Heading, IconButton, Separator, Text } from "@radix-ui/themes";
import { Cross2Icon, GearIcon, PlusIcon } from "@radix-ui/react-icons";

import {
  recentWorkspacesAtom,
  workspacesLoadingAtom,
  activeWorkspaceNameAtom,
  loadRecentWorkspacesAtom,
  removeRecentWorkspaceAtom,
  selectWorkspaceAtom,
  settingsDialogOpenAtom,
  wizardDialogOpenAtom,
  wizardFormDataAtom,
} from "../state/appModeAtoms";
import type { WorkspaceEntry } from "../../shared/types";

export function WorkspaceChooser() {
  const recentWorkspaces = useAtomValue(recentWorkspacesAtom);
  const isLoading = useAtomValue(workspacesLoadingAtom);
  const activeWorkspaceName = useAtomValue(activeWorkspaceNameAtom);
  const loadRecentWorkspaces = useSetAtom(loadRecentWorkspacesAtom);
  const removeRecentWorkspace = useSetAtom(removeRecentWorkspaceAtom);
  const selectWorkspace = useSetAtom(selectWorkspaceAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setWizardDialogOpen = useSetAtom(wizardDialogOpenAtom);
  const setWizardFormData = useSetAtom(wizardFormDataAtom);

  // Load workspaces on mount
  useEffect(() => {
    void loadRecentWorkspaces();
  }, [loadRecentWorkspaces]);

  const handleSelectWorkspace = async (ws: WorkspaceEntry) => {
    try {
      await selectWorkspace(ws.name);
    } catch (error) {
      console.error("Failed to select workspace:", error);
    }
  };

  const handleRemoveWorkspace = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    await removeRecentWorkspace(name);
  };

  const handleCreateNew = () => {
    setWizardFormData({
      workspaceName: "",
      gitUrl: "",
      forkFrom: "",
    });
    setWizardDialogOpen(true);
  };

  const handleOpenSettings = () => {
    setSettingsDialogOpen(true);
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

      {/* Workspaces */}
      <Card style={{ flex: 1, overflow: "hidden" }}>
        <Flex direction="column" style={{ height: "100%" }}>
          <Flex justify="between" align="center" mb="3">
            <Text size="2" weight="medium" color="gray">
              Workspaces
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
                  No workspaces yet
                </Text>
              </Flex>
            ) : (
              <Flex direction="column" gap="2">
                {recentWorkspaces.map((ws) => (
                  <WorkspaceItem
                    key={ws.name}
                    workspace={ws}
                    isActive={ws.name === activeWorkspaceName}
                    onSelect={() => handleSelectWorkspace(ws)}
                    onRemove={(e) => handleRemoveWorkspace(e, ws.name)}
                  />
                ))}
              </Flex>
            )}
          </Box>
        </Flex>
      </Card>

      {/* Action Buttons */}
      <Flex gap="3" mt="4" justify="center">
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
  workspace: WorkspaceEntry;
  isActive: boolean;
  onSelect: () => void;
  onRemove: (e: React.MouseEvent) => void;
}

function WorkspaceItem({ workspace, isActive, onSelect, onRemove }: WorkspaceItemProps) {
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
              {isActive && (
                <Text size="1" color="gray" ml="2">(current)</Text>
              )}
            </Text>
            {workspace.gitUrl && (
              <Text size="1" color="gray" truncate style={{ fontFamily: "var(--font-mono)" }}>
                {workspace.gitUrl}
              </Text>
            )}
          </Flex>
          {!isActive && (
            <IconButton
              variant="ghost"
              size="1"
              color="gray"
              onClick={onRemove}
              style={{ flexShrink: 0 }}
            >
              <Cross2Icon />
            </IconButton>
          )}
        </Flex>
      </button>
    </Card>
  );
}
