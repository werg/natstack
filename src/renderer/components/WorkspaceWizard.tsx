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

export function WorkspaceWizard() {
  const isOpen = useAtomValue(wizardDialogOpenAtom);
  const formData = useAtomValue(wizardFormDataAtom);
  const isCreating = useAtomValue(wizardCreatingAtom);
  const error = useAtomValue(wizardErrorAtom);
  const workspaces = useAtomValue(recentWorkspacesAtom);
  const activeWorkspaceName = useAtomValue(activeWorkspaceNameAtom);

  const setIsOpen = useSetAtom(wizardDialogOpenAtom);
  const setFormData = useSetAtom(wizardFormDataAtom);
  const resetWizard = useSetAtom(resetWizardAtom);
  const createWorkspace = useSetAtom(createWorkspaceAtom);

  const handleClose = () => {
    setIsOpen(false);
    resetWizard();
  };

  const handleCreate = async () => {
    await createWorkspace();
  };

  // Determine source mode: fork takes precedence over gitUrl
  const sourceMode = formData.forkFrom ? "fork" : formData.gitUrl ? "git" : "blank";

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Content maxWidth="450px">
        <Dialog.Title>Create New Workspace</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Give your workspace a name and optionally fork from an existing one or clone a git template.
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
            <Text size="1" color="gray">
              Letters, numbers, hyphens, and underscores only.
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
                  setFormData({ ...formData, forkFrom: value === "__none__" ? "" : value, gitUrl: value !== "__none__" ? "" : formData.gitUrl })
                }
              >
                <Select.Trigger placeholder="Start from scratch" />
                <Select.Content>
                  <Select.Item value="__none__">Start from scratch</Select.Item>
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

          {/* Git URL — only shown when not forking */}
          {!formData.forkFrom && (
            <Flex direction="column" gap="3">
              <Text size="2" weight="medium">
                Git Template URL <Text size="1" color="gray">(optional)</Text>
              </Text>
              <TextField.Root
                value={formData.gitUrl}
                onChange={(e) => setFormData({ ...formData, gitUrl: e.target.value })}
                placeholder="https://github.com/user/template.git"
              />
              <Text size="1" color="gray">
                Clone a template repository to initialize the workspace.
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
            disabled={isCreating || !formData.workspaceName}
            color="green"
          >
            {isCreating ? "Creating..." : "Create Workspace"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
