import { useEffect, useMemo, useState } from "react";
import { Box, Button, Dialog, Flex, Select, Text, TextField, Checkbox } from "@radix-ui/themes";
import type { BranchInfo } from "@natstack/git";

export interface CreateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (options: { name: string; startPoint?: string; checkout?: boolean }) => Promise<void>;
  branches: BranchInfo[];
  remoteBranches: BranchInfo[];
}

export function CreateBranchDialog({
  open,
  onOpenChange,
  onCreate,
  branches,
  remoteBranches,
}: CreateBranchDialogProps) {
  const [name, setName] = useState("");
  const [startPoint, setStartPoint] = useState("HEAD");
  const [checkout, setCheckout] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setStartPoint("HEAD");
      setCheckout(true);
      setSubmitting(false);
    }
  }, [open]);

  const options = useMemo(() => {
    const local = branches.map((branch) => ({
      value: branch.name,
      label: branch.name,
    }));

    const remote = remoteBranches.map((branch) => ({
      value: branch.remote ? `refs/remotes/${branch.remote}/${branch.name}` : branch.name,
      label: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
    }));

    return [
      { value: "HEAD", label: "HEAD" },
      ...local,
      ...remote,
    ];
  }, [branches, remoteBranches]);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onCreate({ name: name.trim(), startPoint, checkout });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Create Branch</Dialog.Title>
        <Dialog.Description size="2">
          <Text>Create a new branch and optionally switch to it.</Text>
        </Dialog.Description>

        <Flex direction="column" gap="3" mt="3">
          <Box>
            <Text size="1" color="gray">Branch name</Text>
            <TextField.Root
              size="2"
              placeholder="feature/my-branch"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Box>

          <Box>
            <Text size="1" color="gray">Start point</Text>
            <Select.Root value={startPoint} onValueChange={setStartPoint}>
              <Select.Trigger />
              <Select.Content>
                {options.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>

          <Flex align="center" gap="2">
            <Checkbox checked={checkout} onCheckedChange={(value) => setCheckout(Boolean(value))} />
            <Text size="2">Checkout branch after create</Text>
          </Flex>
        </Flex>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" disabled={submitting}>
              Cancel
            </Button>
          </Dialog.Close>
          <Button
            variant="solid"
            onClick={() => void handleSubmit()}
            disabled={!name.trim() || submitting}
          >
            {submitting ? "Creating..." : "Create"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
