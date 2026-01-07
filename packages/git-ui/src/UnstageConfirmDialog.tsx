import { AlertDialog, Button, Flex, Text } from "@radix-ui/themes";

export interface UnstageConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileCount: number;
  onConfirm: () => void;
  loading?: boolean;
}

/**
 * Confirmation dialog for unstaging all files
 */
export function UnstageConfirmDialog({
  open,
  onOpenChange,
  fileCount,
  onConfirm,
  loading,
}: UnstageConfirmDialogProps) {
  const fileText = fileCount === 1 ? "1 file" : `${fileCount} files`;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content maxWidth="450px">
        <AlertDialog.Title>Unstage All Changes</AlertDialog.Title>
        <AlertDialog.Description size="2">
          <Text>
            Are you sure you want to unstage{" "}
            <Text weight="bold">{fileText}</Text>? The changes will remain in
            your working directory.
          </Text>
        </AlertDialog.Description>

        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray" disabled={loading}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button
              variant="solid"
              color="amber"
              onClick={onConfirm}
              disabled={loading}
              loading={loading}
            >
              Unstage All
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
