import { Flex, Text, Button, Badge, IconButton, Tooltip } from "@radix-ui/themes";
import {
  PlusIcon,
  MinusIcon,
  TrashIcon,
  Pencil1Icon,
  CheckboxIcon,
} from "@radix-ui/react-icons";
import type { FileChange } from "./types";
import { STATUS_LABELS, STATUS_COLORS } from "./types";

export interface FileDiffHeaderProps {
  file: FileChange;
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onDiscardFile?: (path: string) => void;
  stats?: { additions: number; deletions: number } | null;
  editable?: boolean;
  isEditing?: boolean;
  onToggleEdit?: () => void;
  onSave?: () => void;
  hasChanges?: boolean;
  saving?: boolean;
  partiallyStaged?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: () => void;
}

function TooltipButton({
  label,
  children,
  ...buttonProps
}: {
  label: string;
  children: React.ReactNode;
} & React.ComponentProps<typeof IconButton>) {
  return (
    <Tooltip content={label}>
      <IconButton {...buttonProps}>{children}</IconButton>
    </Tooltip>
  );
}

export function FileDiffHeader({
  file,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  stats,
  editable,
  isEditing,
  onToggleEdit,
  onSave,
  hasChanges,
  saving,
  partiallyStaged,
  selectionMode,
  onToggleSelection,
}: FileDiffHeaderProps) {
  return (
    <Flex align="center" justify="between" p="2">
      <Flex align="center" gap="2">
        <Text size="2" weight="medium">
          {file.path}
        </Text>
        <Badge size="1" variant="soft" color={STATUS_COLORS[file.status]}>
          {STATUS_LABELS[file.status]}
        </Badge>
        {partiallyStaged && (
          <Tooltip content="This file has additional changes not shown here (in the other section)">
            <Badge size="1" variant="outline" color="gray">
              Split
            </Badge>
          </Tooltip>
        )}
        <Text size="1" color="gray">
          +{stats?.additions ?? file.additions ?? 0} -{stats?.deletions ?? file.deletions ?? 0}
        </Text>
      </Flex>

      <Flex gap="1">
        {editable && (
          <>
            {isEditing ? (
              <>
                <Button size="1" variant="soft" color="gray" onClick={onToggleEdit} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  size="1"
                  variant="soft"
                  onClick={onSave}
                  disabled={!hasChanges || saving}
                  loading={saving}
                >
                  Save
                </Button>
              </>
            ) : (
              <TooltipButton
                label="Edit file"
                size="1"
                variant="ghost"
                onClick={onToggleEdit}
                disabled={saving}
              >
                <Pencil1Icon />
              </TooltipButton>
            )}
          </>
        )}

        {onStageFile && (
          <TooltipButton
            label="Stage file"
            size="1"
            variant="ghost"
            onClick={() => onStageFile(file.path)}
            disabled={saving}
          >
            <PlusIcon />
          </TooltipButton>
        )}

        {onUnstageFile && (
          <TooltipButton
            label="Unstage file"
            size="1"
            variant="ghost"
            onClick={() => onUnstageFile(file.path)}
            disabled={saving}
          >
            <MinusIcon />
          </TooltipButton>
        )}

        {onDiscardFile && (
          <TooltipButton
            label="Discard changes"
            size="1"
            variant="ghost"
            onClick={() => onDiscardFile(file.path)}
            disabled={saving}
          >
            <TrashIcon />
          </TooltipButton>
        )}

        {onToggleSelection && (
          <TooltipButton
            label={selectionMode ? "Hide selection" : "Select hunks"}
            size="1"
            variant={selectionMode ? "soft" : "ghost"}
            onClick={onToggleSelection}
            disabled={saving || isEditing}
          >
            <CheckboxIcon />
          </TooltipButton>
        )}
      </Flex>
    </Flex>
  );
}
