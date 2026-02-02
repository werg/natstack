/**
 * Build Error Card
 *
 * Displays detailed build error information when an agent fails to spawn.
 * Shows expandable type errors and build log sections.
 */

import { useState } from "react";
import { Box, Button, Callout, Code, Flex, ScrollArea, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ChevronDownIcon, ChevronUpIcon, Cross2Icon } from "@radix-ui/react-icons";
import type { AgentBuildError } from "@natstack/agentic-messaging";

export interface BuildErrorCardProps {
  agentName: string;
  error: AgentBuildError;
  onDismiss: () => void;
}

export function BuildErrorCard({ agentName, error, onDismiss }: BuildErrorCardProps) {
  const [showTypeErrors, setShowTypeErrors] = useState(false);
  const [showBuildLog, setShowBuildLog] = useState(false);

  const hasTypeErrors = error.typeErrors && error.typeErrors.length > 0;
  const hasBuildLog = Boolean(error.buildLog);

  return (
    <Callout.Root color="red" size="2" mb="2">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Callout.Text>
        <Flex direction="column" gap="2">
          <Flex justify="between" align="start">
            <Box>
              <Text weight="bold">Failed to add {agentName}</Text>
              <Text as="div" size="2" mt="1">{error.message}</Text>
            </Box>
            <Button variant="ghost" size="1" onClick={onDismiss}>
              <Cross2Icon />
            </Button>
          </Flex>

          {/* Dirty repo warning */}
          {error.dirtyRepo && (
            <Callout.Root color="amber" size="1">
              <Callout.Text size="1">
                Agent has uncommitted changes: {error.dirtyRepo.modified.length} modified,{" "}
                {error.dirtyRepo.untracked.length} untracked, {error.dirtyRepo.staged.length} staged
              </Callout.Text>
            </Callout.Root>
          )}

          {/* Type errors section */}
          {hasTypeErrors && (
            <Box>
              <Button
                variant="ghost"
                size="1"
                onClick={() => setShowTypeErrors(!showTypeErrors)}
              >
                {showTypeErrors ? <ChevronUpIcon /> : <ChevronDownIcon />}
                <Text ml="1">{error.typeErrors!.length} TypeScript error(s)</Text>
              </Button>
              {showTypeErrors && (
                <ScrollArea style={{ maxHeight: 200, marginTop: 8 }}>
                  <Box style={{ fontFamily: "var(--code-font-family)", fontSize: 12 }}>
                    {error.typeErrors!.map((e, i) => (
                      <Text key={i} as="div" color="red" size="1">
                        {e.file}:{e.line}:{e.column} - {e.message}
                      </Text>
                    ))}
                  </Box>
                </ScrollArea>
              )}
            </Box>
          )}

          {/* Build log section */}
          {hasBuildLog && (
            <Box>
              <Button
                variant="ghost"
                size="1"
                onClick={() => setShowBuildLog(!showBuildLog)}
              >
                {showBuildLog ? <ChevronUpIcon /> : <ChevronDownIcon />}
                <Text ml="1">Build log</Text>
              </Button>
              {showBuildLog && (
                <ScrollArea style={{ maxHeight: 300, marginTop: 8 }}>
                  <Code
                    size="1"
                    style={{ whiteSpace: "pre-wrap", display: "block", padding: 8 }}
                  >
                    {error.buildLog}
                  </Code>
                </ScrollArea>
              )}
            </Box>
          )}
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}
