import { useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Box, Button, Callout, Dialog, Flex, Select, Spinner, Text, TextField } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";

import {
  wizardDialogOpenAtom,
  wizardFormDataAtom,
  wizardCreatingAtom,
  wizardErrorAtom,
  resetWizardAtom,
  createWorkspaceAtom,
  recentWorkspacesAtom,
  activeWorkspaceNameAtom,
} from "../state/appModeAtoms";
import { useShellOverlay } from "../shell/useShellOverlay";

export function WorkspaceWizard() {
  const isOpen = useAtomValue(wizardDialogOpenAtom);
  useShellOverlay(isOpen);
  const formData = useAtomValue(wizardFormDataAtom);
  const isCreating = useAtomValue(wizardCreatingAtom);
  const error = useAtomValue(wizardErrorAtom);
  const workspaces = useAtomValue(recentWorkspacesAtom);
  const activeWorkspaceName = useAtomValue(activeWorkspaceNameAtom);

  const setIsOpen = useSetAtom(wizardDialogOpenAtom);
  const setFormData = useSetAtom(wizardFormDataAtom);
  const resetWizard = useSetAtom(resetWizardAtom);
  const createWorkspace = useSetAtom(createWorkspaceAtom);

  const nameError = useMemo(() => {
    const name = formData.workspaceName;
    if (!name) return null;
    if (name.length > 64) return "Name too long (max 64 characters)";
    if (/\s/.test(name)) return "Spaces are not allowed — use hyphens instead";
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "Only letters, numbers, hyphens, and underscores";
    return null;
  }, [formData.workspaceName]);

  const handleClose = () => {
    setIsOpen(false);
    resetWizard();
  };

  const handleCreate = async () => {
    await createWorkspace();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Content maxWidth="450px">
        <Dialog.Title>Create New Workspace</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Create a new workspace. Fork from an existing workspace to copy its panels and packages, or start with an empty workspace.
        </Dialog.Description>

        <Flex direction="column" gap="4">
          <Flex direction="column" gap="3">
            <Text size="2" weight="medium">
              Workspace Name
            </Text>
            <TextField.Root
              value={formData.workspaceName}
              onChange={(e) => setFormData({ ...formData, workspaceName: e.target.value })}
              placeholder="my-workspace"
              autoFocus
            />
            <Text size="1" color={nameError ? "red" : "gray"}>
              {nameError ?? "Letters, numbers, hyphens, and underscores only."}
            </Text>
          </Flex>

          {/* Fork from existing workspace */}
          {workspaces.length > 0 && (
            <Flex direction="column" gap="3">
              <Text size="2" weight="medium">
                Fork From <Text size="1" color="gray">(optional)</Text>
              </Text>
              <Select.Root
                value={formData.forkFrom || "__none__"}
                onValueChange={(value) =>
                  setFormData({ ...formData, forkFrom: value === "__none__" ? "" : value })
                }
              >
                <Select.Trigger placeholder="Empty workspace (no panels)" />
                <Select.Content>
                  <Select.Item value="__none__">Empty workspace (no panels)</Select.Item>
                  {workspaces.map((ws) => (
                    <Select.Item key={ws.name} value={ws.name}>
                      {ws.name}{ws.name === activeWorkspaceName ? " (current)" : ""}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <Text size="1" color="gray">
                Copy panels, packages, and agents from an existing workspace.
              </Text>
            </Flex>
          )}

          {/* Error Display */}
          {error && (
            <Callout.Root color="red">
              <Callout.Icon>
                <ExclamationTriangleIcon />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          {/* Progress Indicator */}
          {isCreating && (
            <Flex align="center" justify="center" gap="2" py="3">
              <Spinner />
              <Text size="2" color="gray">
                Creating workspace...
              </Text>
            </Flex>
          )}
        </Flex>

        {/* Buttons */}
        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" disabled={isCreating}>
              Cancel
            </Button>
          </Dialog.Close>

          <Button
            onClick={handleCreate}
            disabled={isCreating || !formData.workspaceName || !!nameError}
            color="green"
          >
            {isCreating ? "Creating..." : "Create Workspace"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
