import { useState, useCallback, useEffect, useRef } from "react";
import { AlertDialog, Button, Flex, Text, Code, Callout } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";

export interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetPath: string;
  isDirectory: boolean;
  onConfirm: () => Promise<void>;
  loading?: boolean;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  targetPath,
  isDirectory,
  onConfirm,
  loading,
}: DeleteConfirmDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  // Track mounted state to prevent state updates after unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Reset error when dialog reopens
  useEffect(() => {
    if (open) {
      setError(null);
    }
  }, [open]);

  const handleConfirm = useCallback(async () => {
    setError(null);
    try {
      await onConfirm();
      // Only update state if component is still mounted
      if (isMountedRef.current) {
        onOpenChange(false);
      }
    } catch (err) {
      // Only update error state if component is still mounted
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [onConfirm, onOpenChange]);

  const fileName = targetPath.split("/").pop() || targetPath;

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content maxWidth="450px">
        <AlertDialog.Title>
          Delete {isDirectory ? "Directory" : "File"}
        </AlertDialog.Title>
        <AlertDialog.Description size="2">
          <Text>
            Are you sure you want to delete <Code>{fileName}</Code>?
          </Text>
        </AlertDialog.Description>

        {isDirectory && (
          <Callout.Root color="orange" size="1" mt="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              This will delete the directory and all its contents.
            </Callout.Text>
          </Callout.Root>
        )}

        {error && (
          <Text size="1" color="red" mt="2">
            {error}
          </Text>
        )}

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
              onClick={() => void handleConfirm()}
              disabled={loading}
            >
              {loading ? "Deleting..." : "Delete"}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
