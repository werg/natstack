import { AlertDialog, Button, Flex, Text } from "@radix-ui/themes";

export interface UnsavedChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
  onSave?: () => void;
}

/**
 * Confirmation dialog for unsaved changes
 */
export function UnsavedChangesDialog({
  open,
  onOpenChange,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content maxWidth="450px">
        <AlertDialog.Title>Unsaved Changes</AlertDialog.Title>
        <AlertDialog.Description size="2">
          <Text>You have unsaved changes. What would you like to do?</Text>
        </AlertDialog.Description>

        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray">
              Keep Editing
            </Button>
          </AlertDialog.Cancel>
          {onSave && (
            <Button variant="soft" color="green" onClick={onSave}>
              Save Changes
            </Button>
          )}
          <AlertDialog.Action>
            <Button variant="solid" color="red" onClick={onDiscard}>
              Discard Changes
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
