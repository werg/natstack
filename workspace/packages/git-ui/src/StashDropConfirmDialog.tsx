import { AlertDialog, Button, Flex, Text } from "@radix-ui/themes";

export interface StashDropConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stashRef: string;
  stashMessage: string;
  onConfirm: () => void;
  loading?: boolean;
}

export function StashDropConfirmDialog({
  open,
  onOpenChange,
  stashRef,
  stashMessage,
  onConfirm,
  loading,
}: StashDropConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content maxWidth="450px">
        <AlertDialog.Title>Drop Stash</AlertDialog.Title>
        <AlertDialog.Description size="2">
          <Text>
            Drop{" "}
            <Text weight="bold" style={{ fontFamily: "monospace" }}>
              {stashRef}
            </Text>
            ? This permanently deletes the stash.
          </Text>
          {stashMessage ? (
            <Text size="1" color="gray" style={{ marginTop: 8 }}>
              {stashMessage}
            </Text>
          ) : null}
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
              color="red"
              onClick={onConfirm}
              disabled={loading}
              loading={loading}
            >
              Drop
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
