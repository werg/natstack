/**
 * Project header with name.
 */

import { Flex, Heading, Text } from "@radix-ui/themes";
import type { ProjectConfig } from "../types";

interface ProjectHeaderProps {
  config: ProjectConfig;
}

export function ProjectHeader({ config }: ProjectHeaderProps) {
  return (
    <Flex direction="column" gap="1">
      <Flex align="center" gap="2">
        <Heading size="5">{config.name}</Heading>
      </Flex>

      <Text size="1" color="gray">
        {`${config.includedRepos?.length ?? 0} repository(s)`}
      </Text>
    </Flex>
  );
}
