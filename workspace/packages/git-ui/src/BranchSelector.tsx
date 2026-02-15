import { useEffect, useMemo, useState } from "react";
import { AlertDialog, Box, Button, DropdownMenu, Flex, Select, Spinner, Text } from "@radix-ui/themes";
import { ChevronDownIcon, PlusIcon, TrashIcon, CheckIcon } from "@radix-ui/react-icons";
import { useGitBranches } from "./hooks/useGitBranches";
import type { BranchInfo } from "@natstack/git";
import { CreateBranchDialog } from "./CreateBranchDialog";

interface BranchSelectorProps {
  currentBranch?: string | null;
}

export function BranchSelector({ currentBranch }: BranchSelectorProps) {
  const { branches, remoteBranches, currentBranch: activeBranch, loading, createBranch, deleteBranch, checkoutBranch } = useGitBranches();
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const branchValue = activeBranch ?? currentBranch ?? "";

  const deleteOptions = useMemo(
    () => branches.filter((branch) => branch.name !== branchValue),
    [branches, branchValue]
  );

  // Initialize deleteTarget when dialog opens, clear when it closes
  useEffect(() => {
    if (showDelete) {
      setDeleteTarget((current) => {
        if (current !== null) return current;
        return deleteOptions[0]?.name ?? null;
      });
    } else {
      setDeleteTarget(null);
    }
  }, [showDelete, deleteOptions]);

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteBranch(deleteTarget);
      setShowDelete(false);
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const handleBranchSelect = (branch: BranchInfo, isRemote: boolean) => {
    if (!isRemote) {
      void checkoutBranch(branch.name);
      return;
    }

    const localExists = branches.some((local) => local.name === branch.name);
    if (localExists) {
      void checkoutBranch(branch.name);
      return;
    }

    if (!branch.remote) return;
    void createBranch({
      name: branch.name,
      startPoint: `refs/remotes/${branch.remote}/${branch.name}`,
      checkout: true,
    });
  };

  if (loading) {
    return <Spinner size="1" />;
  }

  return (
    <Flex align="center" gap="1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button size="1" variant="soft" style={{ minWidth: 120 }}>
            {branchValue || "No branch"}
            <ChevronDownIcon />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content sideOffset={4}>
          {/* Local Branches */}
          {branches.length > 0 && (
            <>
              <DropdownMenu.Label>Local</DropdownMenu.Label>
              {branches.map((branch) => (
                <DropdownMenu.Item
                  key={branch.name}
                  onSelect={() => handleBranchSelect(branch, false)}
                >
                  <Flex align="center" gap="2" width="100%">
                    <Box width="16px">
                      {branch.name === branchValue && <CheckIcon />}
                    </Box>
                    {branch.name}
                  </Flex>
                </DropdownMenu.Item>
              ))}
            </>
          )}

          {/* Remote Branches */}
          {remoteBranches.length > 0 && (
            <>
              <DropdownMenu.Separator />
              <DropdownMenu.Label>Remote</DropdownMenu.Label>
              {remoteBranches.map((branch) => {
                const displayName = branch.remote
                  ? `${branch.remote}/${branch.name}`
                  : branch.name;
                return (
                  <DropdownMenu.Item
                    key={displayName}
                    onSelect={() => handleBranchSelect(branch, true)}
                  >
                    <Flex align="center" gap="2" width="100%">
                      <Box width="16px" />
                      {displayName}
                    </Flex>
                  </DropdownMenu.Item>
                );
              })}
            </>
          )}

          {/* Actions */}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => setShowCreate(true)}>
            <Flex align="center" gap="2">
              <PlusIcon />
              New Branch...
            </Flex>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            color="red"
            onSelect={() => setShowDelete(true)}
            disabled={deleteOptions.length === 0}
          >
            <Flex align="center" gap="2">
              <TrashIcon />
              Delete Branch...
            </Flex>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <CreateBranchDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreate={createBranch}
        branches={branches}
        remoteBranches={remoteBranches}
      />

      <AlertDialog.Root open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialog.Content maxWidth="420px">
          <AlertDialog.Title>Delete Branch</AlertDialog.Title>
          <AlertDialog.Description size="2">
            <Text>Select a branch to delete. This cannot be undone.</Text>
          </AlertDialog.Description>

          <Flex direction="column" gap="3" mt="3">
            <Select.Root value={deleteTarget ?? ""} onValueChange={setDeleteTarget} disabled={deleting}>
              <Select.Trigger placeholder="Select branch" />
              <Select.Content>
                {deleteOptions.map((branch) => (
                  <Select.Item key={branch.name} value={branch.name}>
                    {branch.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {deleteError && (
              <Text size="1" color="red">{deleteError}</Text>
            )}
          </Flex>

          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action>
              <Button
                variant="solid"
                color="red"
                onClick={() => void handleDelete()}
                disabled={!deleteTarget || deleting}
                loading={deleting}
              >
                Delete Branch
              </Button>
            </AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Flex>
  );
}
