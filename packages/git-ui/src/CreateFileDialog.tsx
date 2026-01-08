import { useState, useCallback, useEffect } from "react";
import { Dialog, Button, Flex, Text, TextField, SegmentedControl } from "@radix-ui/themes";

export interface CreateFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentPath: string | null;
  onCreate: (name: string, isDirectory: boolean) => Promise<void>;
  loading?: boolean;
}

export function CreateFileDialog({
  open,
  onOpenChange,
  parentPath,
  onCreate,
  loading,
}: CreateFileDialogProps) {
  const [name, setName] = useState("");
  const [isDirectory, setIsDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setName("");
      setIsDirectory(false);
      setError(null);
    }
  }, [open]);

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();

    // Validate
    if (!trimmedName) {
      setError("Name cannot be empty");
      return;
    }
    if (trimmedName.includes("/") || trimmedName.includes("\\")) {
      setError("Name cannot contain slashes");
      return;
    }
    if (trimmedName === "." || trimmedName === "..") {
      setError("Invalid name");
      return;
    }

    // Validate against control characters and null bytes
    if (/[\x00-\x1f\x7f]/.test(trimmedName)) {
      setError("Invalid name - control characters not allowed");
      return;
    }

    setError(null);

    const fullPath = parentPath ? `${parentPath}/${trimmedName}` : trimmedName;

    // Final validation: ensure the path doesn't try to escape
    // Normalize and check for parent directory references
    const normalizedPath = fullPath.replace(/\\/g, "/");
    if (normalizedPath.includes("/../") || normalizedPath.startsWith("../") || normalizedPath.endsWith("/..")) {
      setError("Invalid path - directory traversal not allowed");
      return;
    }

    try {
      await onCreate(fullPath, isDirectory);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [name, isDirectory, parentPath, onCreate, onOpenChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !loading) {
        e.preventDefault();
        void handleCreate();
      }
    },
    [handleCreate, loading]
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="400px">
        <Dialog.Title>
          Create {isDirectory ? "Directory" : "File"}
        </Dialog.Title>
        <Dialog.Description size="2" color="gray">
          {parentPath ? `In: ${parentPath}/` : "At repository root"}
        </Dialog.Description>

        <Flex direction="column" gap="3" mt="4">
          <SegmentedControl.Root
            value={isDirectory ? "directory" : "file"}
            onValueChange={(v) => setIsDirectory(v === "directory")}
          >
            <SegmentedControl.Item value="file">File</SegmentedControl.Item>
            <SegmentedControl.Item value="directory">Directory</SegmentedControl.Item>
          </SegmentedControl.Root>

          <TextField.Root
            placeholder={isDirectory ? "Directory name" : "File name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />

          {error && (
            <Text size="1" color="red">
              {error}
            </Text>
          )}
        </Flex>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" disabled={loading}>
              Cancel
            </Button>
          </Dialog.Close>
          <Button onClick={() => void handleCreate()} disabled={loading || !name.trim()}>
            {loading ? "Creating..." : "Create"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
