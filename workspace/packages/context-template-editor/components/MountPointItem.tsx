/**
 * Single mount point row in the editor.
 */

import { Flex, Text, TextField, IconButton, Badge, Tooltip } from "@radix-ui/themes";
import { Cross2Icon, LockClosedIcon, ExclamationTriangleIcon, CubeIcon } from "@radix-ui/react-icons";
import type { MountPoint, RefSelection } from "../types";
import { RefSelector } from "./RefSelector";

interface MountPointItemProps {
  /** The mount point data */
  mount: MountPoint;
  /** Called when path changes */
  onPathChange: (path: string) => void;
  /** Called when ref changes */
  onRefChange: (ref: RefSelection) => void;
  /** Called when removed */
  onRemove: () => void;
  /** Validation error message */
  error?: string;
}

export function MountPointItem({
  mount,
  onPathChange,
  onRefChange,
  onRemove,
  error,
}: MountPointItemProps) {
  const isInherited = mount.isInherited;

  return (
    <Flex
      align="center"
      gap="2"
      py="2"
      px="3"
      style={{
        borderRadius: "var(--radius-2)",
        backgroundColor: isInherited
          ? "var(--gray-a2)"
          : error
          ? "var(--red-a2)"
          : "var(--gray-a3)",
      }}
    >
      {/* Icon */}
      <Flex align="center" style={{ width: 24 }}>
        {isInherited ? (
          <Tooltip content="Inherited from parent template">
            <LockClosedIcon color="var(--gray-9)" />
          </Tooltip>
        ) : error ? (
          <Tooltip content={error}>
            <ExclamationTriangleIcon color="var(--red-9)" />
          </Tooltip>
        ) : (
          <CubeIcon color="var(--gray-9)" />
        )}
      </Flex>

      {/* Path */}
      <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
        {isInherited ? (
          <Text size="2" style={{ fontFamily: "monospace" }}>
            {mount.path}
          </Text>
        ) : (
          <TextField.Root
            size="1"
            value={mount.path}
            onChange={(e) => onPathChange(e.target.value)}
            placeholder="/workspace/..."
            style={{ fontFamily: "monospace" }}
          />
        )}
      </Flex>

      {/* Repo */}
      <Flex align="center" style={{ minWidth: 120 }}>
        <Badge variant="soft" color="gray" style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
          {mount.repoSpec.split("/").pop()}
        </Badge>
      </Flex>

      {/* Ref selector */}
      <Flex align="center" style={{ minWidth: 100 }}>
        <RefSelector
          value={mount.ref}
          onChange={onRefChange}
          repoSpec={mount.repoSpec}
          disabled={isInherited}
        />
      </Flex>

      {/* Remove button */}
      <Flex align="center" style={{ width: 28 }}>
        {!isInherited && (
          <Tooltip content="Remove">
            <IconButton size="1" variant="ghost" color="red" onClick={onRemove}>
              <Cross2Icon />
            </IconButton>
          </Tooltip>
        )}
      </Flex>
    </Flex>
  );
}
