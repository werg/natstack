/**
 * Visual representation of template inheritance chain.
 */

import { Flex, Text, Badge } from "@radix-ui/themes";
import { ArrowRightIcon } from "@radix-ui/react-icons";

interface InheritanceChainProps {
  /** List of template specs in inheritance order (root first, current last) */
  chain: string[];
  /** Current template name */
  currentName: string;
}

export function InheritanceChain({ chain, currentName }: InheritanceChainProps) {
  if (chain.length === 0) {
    return null;
  }

  return (
    <Flex align="center" gap="2" wrap="wrap" py="2">
      <Text size="1" color="gray">
        Inherits from:
      </Text>
      {chain.map((spec, index) => (
        <Flex key={spec} align="center" gap="1">
          <Badge variant="soft" color="gray">
            {spec.split("/").pop()}
          </Badge>
          {index < chain.length - 1 && (
            <ArrowRightIcon color="var(--gray-8)" />
          )}
        </Flex>
      ))}
      <ArrowRightIcon color="var(--gray-8)" />
      <Badge variant="soft" color="blue">
        {currentName}
      </Badge>
    </Flex>
  );
}
