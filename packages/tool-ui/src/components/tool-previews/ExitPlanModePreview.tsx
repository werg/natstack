/**
 * ExitPlanModePreview - Plan approval UI for ExitPlanMode tool
 *
 * Shows the requested bash permissions (allowedPrompts) in a clean,
 * scannable format. These permissions will be auto-approved during
 * implementation if the user approves the plan.
 *
 * If planFilePath is provided by the SDK, it's displayed so the user
 * knows where to find the full plan.
 */

import { Box, Text, Flex, Badge, Card, Code } from "@radix-ui/themes";
import { CheckCircledIcon, LightningBoltIcon, FileTextIcon } from "@radix-ui/react-icons";
import type { AllowedPrompt } from "@natstack/agentic-messaging";

export interface ExitPlanModePreviewProps {
  allowedPrompts?: AllowedPrompt[];
  /** Path to the plan file (if provided by SDK) */
  planFilePath?: string;
}

/** Get a short display path (last 3 segments) */
function getShortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

export function ExitPlanModePreview({ allowedPrompts, planFilePath }: ExitPlanModePreviewProps) {
  const hasPermissions = allowedPrompts && allowedPrompts.length > 0;

  return (
    <Box>
      {/* Header */}
      <Flex gap="2" align="center" mb="3">
        <CheckCircledIcon style={{ color: "var(--green-9)", width: 18, height: 18 }} />
        <Text size="2" weight="medium">
          Ready to implement
        </Text>
      </Flex>

      {/* Plan file location (if provided) */}
      {planFilePath && (
        <Flex gap="2" align="center" mb="3">
          <FileTextIcon style={{ color: "var(--gray-9)" }} />
          <Text size="2" color="gray">
            Plan:{" "}
            <Code size="2" title={planFilePath}>
              {getShortPath(planFilePath)}
            </Code>
          </Text>
        </Flex>
      )}

      {/* Permissions section */}
      {hasPermissions ? (
        <Card size="1">
          <Flex direction="column" gap="2">
            <Flex gap="2" align="center">
              <LightningBoltIcon style={{ color: "var(--amber-9)" }} />
              <Text size="2" weight="medium">
                Requested permissions:
              </Text>
            </Flex>
            <Text size="1" color="gray" mb="2">
              These bash commands will be auto-approved during implementation:
            </Text>
            <Flex direction="column" gap="2">
              {allowedPrompts.map((prompt, index) => (
                <Flex key={index} gap="2" align="center">
                  <Badge color="amber" size="1" variant="soft">
                    Bash
                  </Badge>
                  <Text size="2" style={{ fontFamily: "monospace" }}>
                    {prompt.prompt}
                  </Text>
                </Flex>
              ))}
            </Flex>
          </Flex>
        </Card>
      ) : (
        <Card size="1">
          <Flex gap="2" align="center">
            <CheckCircledIcon style={{ color: "var(--green-9)" }} />
            <Text size="2" color="gray">
              No special permissions requested
            </Text>
          </Flex>
        </Card>
      )}

      {/* Help text */}
      <Text size="1" color="gray" mt="2" style={{ display: "block" }}>
        Approving will allow Claude to proceed with implementation.
      </Text>
    </Box>
  );
}
