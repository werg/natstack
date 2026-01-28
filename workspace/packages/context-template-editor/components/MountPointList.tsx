/**
 * List of mount points in the template editor.
 */

import { Box, Flex, Text, Separator } from "@radix-ui/themes";
import type { MountPoint, RefSelection } from "../types";
import type { ValidationError } from "../hooks/useTemplateState";
import { MountPointItem } from "./MountPointItem";

interface MountPointListProps {
  /** All mount points (user + inherited) */
  mountPoints: MountPoint[];
  /** Validation errors */
  errors: ValidationError[];
  /** Called when a mount path changes */
  onPathChange: (id: string, path: string) => void;
  /** Called when a mount ref changes */
  onRefChange: (id: string, ref: RefSelection) => void;
  /** Called when a mount is removed */
  onRemove: (id: string) => void;
  /** Parent template spec (for display) */
  parentSpec?: string;
}

export function MountPointList({
  mountPoints,
  errors,
  onPathChange,
  onRefChange,
  onRemove,
  parentSpec,
}: MountPointListProps) {
  const userMounts = mountPoints.filter((mp) => !mp.isInherited);
  const inheritedMounts = mountPoints.filter((mp) => mp.isInherited);

  const getError = (id: string): string | undefined => {
    const err = errors.find((e) => e.mountId === id);
    return err?.message;
  };

  return (
    <Box>
      {/* Header */}
      <Flex align="center" gap="2" mb="2">
        <Text size="2" weight="medium">
          Mount Points
        </Text>
        <Text size="1" color="gray">
          ({mountPoints.length} total)
        </Text>
      </Flex>

      {/* User-defined mounts */}
      {userMounts.length > 0 && (
        <Flex direction="column" gap="1" mb="3">
          {userMounts.map((mount) => (
            <MountPointItem
              key={mount.id}
              mount={mount}
              onPathChange={(path) => onPathChange(mount.id, path)}
              onRefChange={(ref) => onRefChange(mount.id, ref)}
              onRemove={() => onRemove(mount.id)}
              error={getError(mount.id)}
            />
          ))}
        </Flex>
      )}

      {/* Empty state for user mounts */}
      {userMounts.length === 0 && (
        <Box py="3" style={{ textAlign: "center" }}>
          <Text size="2" color="gray">
            No repositories added. Click "Add Repository" to add one.
          </Text>
        </Box>
      )}

      {/* Inherited mounts */}
      {inheritedMounts.length > 0 && (
        <>
          <Separator size="4" my="3" />
          <Flex align="center" gap="2" mb="2">
            <Text size="1" color="gray">
              Inherited from: {parentSpec ?? "parent"}
            </Text>
          </Flex>
          <Flex direction="column" gap="1">
            {inheritedMounts.map((mount) => (
              <MountPointItem
                key={mount.id}
                mount={mount}
                onPathChange={() => {}}
                onRefChange={() => {}}
                onRemove={() => {}}
                error={getError(mount.id)}
              />
            ))}
          </Flex>
        </>
      )}
    </Box>
  );
}
