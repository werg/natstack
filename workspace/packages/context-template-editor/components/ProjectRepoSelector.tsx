/**
 * Selector for project repo location (panels/, workers/, projects/).
 */

import { useState } from "react";
import { Flex, Text, TextField, Select, Button, Box, Callout } from "@radix-ui/themes";
import { InfoCircledIcon } from "@radix-ui/react-icons";

export type RepoLocation = "panels" | "workers" | "projects";

interface ProjectRepoSelectorProps {
  /** Current repo name */
  repoName: string;
  /** Called when repo name changes */
  onRepoNameChange: (name: string) => void;
  /** Current location */
  location: RepoLocation;
  /** Called when location changes */
  onLocationChange: (location: RepoLocation) => void;
  /** Whether this is an existing repo (vs creating new) */
  isExisting?: boolean;
  /** Validation error */
  error?: string;
}

export function ProjectRepoSelector({
  repoName,
  onRepoNameChange,
  location,
  onLocationChange,
  isExisting,
  error,
}: ProjectRepoSelectorProps) {
  const fullPath = `${location}/${repoName}`;

  return (
    <Box>
      <Text size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Project Repository
      </Text>

      <Flex gap="2" align="end">
        {/* Location dropdown */}
        <Flex direction="column" gap="1">
          <Text size="1" color="gray">
            Location
          </Text>
          <Select.Root
            value={location}
            onValueChange={(v) => onLocationChange(v as RepoLocation)}
            disabled={isExisting}
          >
            <Select.Trigger style={{ minWidth: 120 }} />
            <Select.Content>
              <Select.Item value="panels">
                <Text size="2">panels/</Text>
              </Select.Item>
              <Select.Item value="workers">
                <Text size="2">workers/</Text>
              </Select.Item>
              <Select.Item value="projects">
                <Text size="2">projects/</Text>
              </Select.Item>
            </Select.Content>
          </Select.Root>
        </Flex>

        {/* Repo name input */}
        <Flex direction="column" gap="1" style={{ flex: 1 }}>
          <Text size="1" color="gray">
            Repository Name
          </Text>
          <TextField.Root
            size="2"
            value={repoName}
            onChange={(e) => onRepoNameChange(e.target.value)}
            placeholder="my-project"
            disabled={isExisting}
          />
        </Flex>
      </Flex>

      {/* Path preview */}
      <Text size="1" color="gray" mt="2" style={{ display: "block", fontFamily: "monospace" }}>
        {fullPath ? `workspace/${fullPath}/` : "workspace/..."}
      </Text>

      {/* Error message */}
      {error && (
        <Callout.Root color="red" size="1" mt="2">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      {/* Info about template location */}
      {!isExisting && (
        <Callout.Root color="blue" size="1" mt="2">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text>
            The context template will be saved as <code>context.yaml</code> in this repository.
          </Callout.Text>
        </Callout.Root>
      )}
    </Box>
  );
}
