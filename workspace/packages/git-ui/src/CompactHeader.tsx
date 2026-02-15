import { Flex, TextField, Button, Tooltip, IconButton } from "@radix-ui/themes";
import { ChevronDownIcon } from "@radix-ui/react-icons";

export interface CompactHeaderProps {
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  onCommit: () => void;
  onExpand: () => void;
  hasStaged: boolean;
  loading: boolean;
}

export function CompactHeader({
  commitMessage,
  onCommitMessageChange,
  onCommit,
  onExpand,
  hasStaged,
  loading,
}: CompactHeaderProps) {
  const canCommit = hasStaged && commitMessage.trim() && !loading;

  return (
    <Flex
      align="center"
      gap="2"
      p="2"
      style={{ borderBottom: "1px solid var(--gray-a5)" }}
    >
      <TextField.Root
        size="1"
        placeholder="Commit message..."
        value={commitMessage}
        onChange={(e) => onCommitMessageChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canCommit) {
            e.preventDefault();
            onCommit();
          }
        }}
        style={{ flex: 1, maxWidth: 400 }}
        aria-label="Commit message"
      />
      <Button
        size="1"
        onClick={onCommit}
        disabled={!canCommit}
        aria-label={loading ? "Committing changes" : "Commit staged changes"}
      >
        {loading ? "Committing..." : "Commit"}
      </Button>
      <Tooltip content="Expand header">
        <IconButton size="1" variant="ghost" onClick={onExpand} aria-label="Expand header">
          <ChevronDownIcon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}
