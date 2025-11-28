import { useAtomValue, useSetAtom } from "jotai";
import { Box, Button, Callout, Dialog, Flex, Spinner, Text, TextField } from "@radix-ui/themes";
import { ExclamationTriangleIcon, FileIcon } from "@radix-ui/react-icons";

import {
  wizardDialogOpenAtom,
  wizardStepAtom,
  wizardFormDataAtom,
  wizardCreatingAtom,
  wizardErrorAtom,
  resetWizardAtom,
  createWorkspaceAtom,
} from "../state/appModeAtoms";

export function WorkspaceWizard() {
  const isOpen = useAtomValue(wizardDialogOpenAtom);
  const step = useAtomValue(wizardStepAtom);
  const formData = useAtomValue(wizardFormDataAtom);
  const isCreating = useAtomValue(wizardCreatingAtom);
  const error = useAtomValue(wizardErrorAtom);

  const setIsOpen = useSetAtom(wizardDialogOpenAtom);
  const setStep = useSetAtom(wizardStepAtom);
  const setFormData = useSetAtom(wizardFormDataAtom);
  const resetWizard = useSetAtom(resetWizardAtom);
  const createWorkspace = useSetAtom(createWorkspaceAtom);

  const handleClose = () => {
    setIsOpen(false);
    resetWizard();
  };

  const handleSelectFolder = async () => {
    try {
      const folderPath = await window.electronAPI.openFolderDialog();
      if (folderPath) {
        const validation = await window.electronAPI.validateWorkspacePath(folderPath);
        setFormData({
          ...formData,
          folderPath: validation.path,
          workspaceName: formData.workspaceName || validation.name,
        });
      }
    } catch (err) {
      console.error("Failed to select folder:", err);
    }
  };

  const handleNext = () => {
    if (step === 0 && !formData.folderPath) {
      return; // Require folder path
    }
    setStep(step + 1);
  };

  const handleBack = () => {
    setStep(Math.max(0, step - 1));
  };

  const handleCreate = async () => {
    await createWorkspace();
  };

  const canProceed = () => {
    if (step === 0) return !!formData.folderPath;
    if (step === 1) return !!formData.workspaceName;
    return true;
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <Dialog.Content maxWidth="450px">
        <Dialog.Title>Create New Workspace</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          {step === 0 && "Choose a folder for your workspace."}
          {step === 1 && "Give your workspace a name."}
        </Dialog.Description>

        <Flex direction="column" gap="4">
          {/* Step 0: Select Folder */}
          {step === 0 && (
            <Flex direction="column" gap="3">
              <Text size="2" weight="medium">
                Workspace Folder
              </Text>
              <Flex gap="2">
                <TextField.Root
                  value={formData.folderPath}
                  onChange={(e) => setFormData({ ...formData, folderPath: e.target.value })}
                  placeholder="/path/to/workspace"
                  style={{ flex: 1 }}
                />
                <Button variant="soft" onClick={handleSelectFolder}>
                  <FileIcon />
                  Browse
                </Button>
              </Flex>
              <Text size="1" color="gray">
                This folder will contain your panels, git repositories, and cache.
              </Text>
            </Flex>
          )}

          {/* Step 1: Workspace Name */}
          {step === 1 && (
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
                This name will be used to identify the workspace.
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

        {/* Navigation Buttons */}
        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" disabled={isCreating}>
              Cancel
            </Button>
          </Dialog.Close>

          {step > 0 && (
            <Button variant="soft" onClick={handleBack} disabled={isCreating}>
              Back
            </Button>
          )}

          {step < 1 ? (
            <Button onClick={handleNext} disabled={!canProceed()}>
              Next
            </Button>
          ) : (
            <Button onClick={handleCreate} disabled={isCreating || !canProceed()} color="green">
              {isCreating ? "Creating..." : "Create Workspace"}
            </Button>
          )}
        </Flex>

        {/* Step Indicator */}
        <Box mt="4">
          <Flex gap="2" justify="center">
            {[0, 1].map((s) => (
              <Box
                key={s}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor:
                    s === step ? "var(--accent-9)" : s < step ? "var(--accent-6)" : "var(--gray-5)",
                }}
              />
            ))}
          </Flex>
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}
