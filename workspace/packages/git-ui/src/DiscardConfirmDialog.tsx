import { AlertDialog, Button, Flex, Code, Box } from "@radix-ui/themes";

export interface DiscardConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  onConfirm: () => void;
  loading?: boolean;
}

/**
 * Confirmation dialog for discarding file changes
 */
export function DiscardConfirmDialog({
  open,
  onOpenChange,
  filePath,
  onConfirm,
  loading,
}: DiscardConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content
        style={{
          width: "min(500px, calc(100vw - 24px))",
          maxHeight: "calc(100dvh - 24px)",
          overflow: "auto",
        }}
      >
        <AlertDialog.Title>Discard Changes</AlertDialog.Title>
        <AlertDialog.Description size="2">
          Are you sure you want to discard all changes to this file? This action cannot be undone.
        </AlertDialog.Description>
        <Box mt="2">
          <Code size="2" style={{ wordBreak: "break-all" }}>
            {filePath}
          </Code>
        </Box>

        <Flex gap="3" mt="4" justify="end" wrap="wrap">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray" disabled={loading}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button
              variant="solid"
              color="red"
              onClick={onConfirm}
              disabled={loading}
              loading={loading}
            >
              Discard Changes
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
