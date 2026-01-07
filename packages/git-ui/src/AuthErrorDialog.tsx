import { AlertDialog, Button, Flex, Text } from "@radix-ui/themes";

export interface AuthErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message?: string;
}

export function AuthErrorDialog({ open, onOpenChange, message }: AuthErrorDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content maxWidth="420px">
        <AlertDialog.Title>Authentication Required</AlertDialog.Title>
        <AlertDialog.Description size="2">
          <Text>{message ?? "Your credentials were rejected. Please sign in again."}</Text>
        </AlertDialog.Description>
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Action>
            <Button variant="solid">OK</Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
