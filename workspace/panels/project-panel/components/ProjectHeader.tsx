/**
 * Project header with name and mode badge.
 */

import { Flex, Heading, Badge, Text } from "@radix-ui/themes";
import { LaptopIcon, GlobeIcon } from "@radix-ui/react-icons";
import type { ProjectConfig } from "../types";

interface ProjectHeaderProps {
  config: ProjectConfig;
}

export function ProjectHeader({ config }: ProjectHeaderProps) {
  const isManaged = config.projectLocation === "managed";

  return (
    <Flex direction="column" gap="1">
      <Flex align="center" gap="2">
        <Heading size="5">{config.name}</Heading>
        <Badge color={isManaged ? "blue" : "gray"} size="1">
          {isManaged ? (
            <>
              <GlobeIcon style={{ marginRight: 4 }} />
              Managed
            </>
          ) : (
            <>
              <LaptopIcon style={{ marginRight: 4 }} />
              External
            </>
          )}
        </Badge>
      </Flex>

      <Text size="1" color="gray">
        {isManaged
          ? `${config.includedRepos?.length ?? 0} repository(s)`
          : config.workingDirectory ?? "No directory set"}
      </Text>
    </Flex>
  );
}
