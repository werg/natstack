import { Flex, IconButton, TextField, Tooltip } from "@radix-ui/themes";
import { Cross2Icon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type { FileFilter, FileChange } from "./types";

const statusOptions: Array<{ key: FileChange["status"]; label: string }> = [
  { key: "added", label: "A" },
  { key: "modified", label: "M" },
  { key: "deleted", label: "D" },
  { key: "renamed", label: "R" },
];

interface CompactFileSearchProps {
  filter: FileFilter;
  onFilterChange: (next: FileFilter) => void;
  statusCounts: Record<FileChange["status"], number>;
}

/**
 * Compact inline search for file tree header.
 * Always visible, expands to fill available width.
 * Only shows status options that have files, hides filter buttons if only one status.
 */
export function CompactFileSearch({ filter, onFilterChange, statusCounts }: CompactFileSearchProps) {
  const activeStatuses = filter.status ?? [];

  // Only include statuses that have files
  const availableStatuses = statusOptions.filter((s) => (statusCounts[s.key] ?? 0) > 0);
  // Hide status buttons if only one type (nothing to filter)
  const showStatusButtons = availableStatuses.length > 1;

  const toggleStatus = (status: FileChange["status"]) => {
    const next = new Set(activeStatuses);
    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
    }
    onFilterChange({
      ...filter,
      status: next.size === 0 ? null : Array.from(next),
    });
  };

  return (
    <Flex align="center" gap="1" flexGrow="1">
      <TextField.Root
        size="1"
        placeholder="Filter..."
        value={filter.search}
        onChange={(e) => onFilterChange({ ...filter, search: e.target.value })}
        style={{ flex: 1, minWidth: 60, boxShadow: "none" }}
      >
        <TextField.Slot>
          <MagnifyingGlassIcon height="12" width="12" />
        </TextField.Slot>
        {filter.search && (
          <TextField.Slot>
            <IconButton
              size="1"
              variant="ghost"
              onClick={() => onFilterChange({ ...filter, search: "" })}
            >
              <Cross2Icon height="12" width="12" />
            </IconButton>
          </TextField.Slot>
        )}
      </TextField.Root>

      {showStatusButtons && availableStatuses.map((status) => {
        const active = activeStatuses.includes(status.key);
        return (
          <Tooltip key={status.key} content={`${status.key} (${statusCounts[status.key]})`}>
            <IconButton
              size="1"
              variant={active ? "soft" : "ghost"}
              onClick={() => toggleStatus(status.key)}
            >
              {status.label}
            </IconButton>
          </Tooltip>
        );
      })}
    </Flex>
  );
}
