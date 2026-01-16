/**
 * Dialog for confirming close of tabs with unsaved changes.
 */

import { Dialog, Flex, Text, Button } from "@radix-ui/themes";

export interface UnsavedChangesDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** File name being closed */
  fileName: string;
  /** Called when user wants to save */
  onSave: () => void;
  /** Called when user wants to discard changes */
  onDiscard: () => void;
  /** Called when user cancels the action */
  onCancel: () => void;
}

export function UnsavedChangesDialog({
  open,
  fileName,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <Dialog.Content style={{ maxWidth: 400 }}>
        <Dialog.Title>Unsaved Changes</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Do you want to save the changes you made to{" "}
          <Text weight="medium">{fileName}</Text>?
        </Dialog.Description>

        <Flex gap="3" mt="4" justify="end">
          <Button variant="soft" color="gray" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="soft" color="red" onClick={onDiscard}>
            Don't Save
          </Button>
          <Button onClick={onSave}>Save</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
