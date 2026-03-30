import { useState, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertDialog, Box, Button, Callout, Card, Flex, Heading, IconButton, Spinner, Text } from "@radix-ui/themes";
import { Cross2Icon, ExclamationTriangleIcon, PlusIcon } from "@radix-ui/react-icons";

import {
  recentWorkspacesAtom,
  workspacesLoadingAtom,
  activeWorkspaceNameAtom,
  loadRecentWorkspacesAtom,
  removeRecentWorkspaceAtom,
  selectWorkspaceAtom,
  workspaceChooserDialogOpenAtom,
  wizardDialogOpenAtom,
  wizardFormDataAtom,
  workspaceErrorAtom,
} from "../state/appModeAtoms";
import type { WorkspaceEntry } from "@natstack/shared/types";

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function WorkspaceChooser() {
  const recentWorkspaces = useAtomValue(recentWorkspacesAtom);
  const isLoading = useAtomValue(workspacesLoadingAtom);
  const activeWorkspaceName = useAtomValue(activeWorkspaceNameAtom);
  const loadRecentWorkspaces = useSetAtom(loadRecentWorkspacesAtom);
  const removeRecentWorkspace = useSetAtom(removeRecentWorkspaceAtom);
  const selectWorkspace = useSetAtom(selectWorkspaceAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const setWizardDialogOpen = useSetAtom(wizardDialogOpenAtom);
  const setWizardFormData = useSetAtom(wizardFormDataAtom);
  const workspaceError = useAtomValue(workspaceErrorAtom);
  const setWorkspaceError = useSetAtom(workspaceErrorAtom);

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Load workspaces on mount and clear stale errors
  useEffect(() => {
    setWorkspaceError(null);
    void loadRecentWorkspaces();
  }, [loadRecentWorkspaces, setWorkspaceError]);

  const handleSelectWorkspace = async (ws: WorkspaceEntry) => {
    if (ws.name === activeWorkspaceName) {
      setWorkspaceChooserOpen(false);
      return;
    }
    try {
      await selectWorkspace(ws.name);
    } catch (error) {
      console.error("Failed to select workspace:", error);
    }
  };

  const handleRemoveWorkspace = (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    setPendingDelete(name);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete;
    setPendingDelete(null);
    await removeRecentWorkspace(name);
  };

  const handleCreateNew = () => {
    setWizardFormData({
      workspaceName: "",
      forkFrom: "",
    });
    setWizardDialogOpen(true);
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

          {/* Error display */}
          {workspaceError && (
            <Callout.Root color="red" mb="2" style={{ cursor: "pointer" }} onClick={() => setWorkspaceError(null)}>
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text>{workspaceError}</Callout.Text>
            </Callout.Root>
          )}

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
                {isLoading ? (
                  <Spinner size="2" />
                ) : (
                  <Text size="2" color="gray">Could not load workspaces</Text>
                )}
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

      {/* Delete confirmation dialog */}
      <AlertDialog.Root open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialog.Content maxWidth="400px">
          <AlertDialog.Title>Delete workspace</AlertDialog.Title>
          <AlertDialog.Description>
            Permanently delete &ldquo;{pendingDelete}&rdquo;? All panels, packages, agents, and data will be removed. This cannot be undone.
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button color="red" onClick={handleConfirmDelete}>Delete</Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
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
            <Text size="1" color="gray">
              {formatRelativeTime(workspace.lastOpened)}
            </Text>
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
