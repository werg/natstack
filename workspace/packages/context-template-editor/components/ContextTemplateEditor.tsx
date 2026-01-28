/**
 * Main context template editor component.
 *
 * Allows users to:
 * - Create a new project repo with context.yaml
 * - Select parent template (extends)
 * - Add repositories as mount points
 * - Configure git refs for each mount
 */

import { useState, useCallback, useEffect } from "react";
import { Box, Flex, Text, Button, Separator, Card, Callout, Spinner } from "@radix-ui/themes";
import { CheckIcon, Cross2Icon, InfoCircledIcon } from "@radix-ui/react-icons";
import { useTemplateState } from "../hooks/useTemplateState";
import { ParentTemplateSelector } from "./ParentTemplateSelector";
import { ProjectRepoSelector, type RepoLocation } from "./ProjectRepoSelector";
import { MountPointList } from "./MountPointList";
import { RepoSelector } from "./RepoSelector";
import { InheritanceChain } from "./InheritanceChain";
import type { ContextTemplateYaml } from "../types";

interface ContextTemplateEditorProps {
  /** Called when template is saved successfully */
  onSave?: (templateSpec: string) => void;
  /** Called when editor is cancelled */
  onCancel?: () => void;
  /** Initial parent template spec */
  initialParent?: string;
  /** Whether editor is in expanded view */
  expanded?: boolean;
}

export function ContextTemplateEditor({
  onSave,
  onCancel,
  initialParent,
  expanded = true,
}: ContextTemplateEditorProps) {
  // Project repo state
  const [repoName, setRepoName] = useState("");
  const [repoLocation, setRepoLocation] = useState<RepoLocation>("projects");
  const [repoError, setRepoError] = useState<string | undefined>();

  // Template state
  const {
    state,
    allMountPoints,
    errors,
    isValid,
    setExtends,
    addMountPoint,
    removeMountPoint,
    updateMountPath,
    updateMountRef,
    getYaml,
  } = useTemplateState({
    projectName: repoName || "untitled",
  });

  // Saving state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  // Initialize parent if provided
  useEffect(() => {
    if (initialParent) {
      setExtends(initialParent);
    }
  }, [initialParent, setExtends]);

  // Generate template spec from location and name
  const templateSpec = repoName ? `${repoLocation}/${repoName}` : "";

  // Validate repo name
  const validateRepoName = useCallback((name: string): string | undefined => {
    if (!name.trim()) {
      return "Repository name is required";
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      return "Use lowercase letters, numbers, and hyphens only";
    }
    if (name.startsWith("-") || name.endsWith("-")) {
      return "Cannot start or end with a hyphen";
    }
    return undefined;
  }, []);

  const handleRepoNameChange = (name: string) => {
    setRepoName(name);
    setRepoError(validateRepoName(name));
  };

  // Handle adding a new mount point
  const handleAddRepo = (repoSpec: string) => {
    addMountPoint(repoSpec);
  };

  // Handle save
  const handleSave = async () => {
    // Validate
    const nameError = validateRepoName(repoName);
    if (nameError) {
      setRepoError(nameError);
      return;
    }

    if (!isValid) {
      setSaveError("Please fix validation errors before saving");
      return;
    }

    setSaving(true);
    setSaveError(undefined);

    try {
      // Convert state to YAML
      const yaml = getYaml();

      // Call bridge to save template
      const bridge = (window as any).bridge;
      if (!bridge?.saveTemplateToRepo) {
        throw new Error("Bridge method saveTemplateToRepo not available");
      }

      await bridge.saveTemplateToRepo({
        location: repoLocation,
        repoName,
        template: yaml,
      });

      onSave?.(templateSpec);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  // Get repos already added (to exclude from selector)
  const addedRepos = allMountPoints.map((m) => m.repoSpec);

  if (!expanded) {
    return (
      <Card>
        <Flex align="center" justify="between">
          <Text size="2" weight="medium">
            Create Context Template
          </Text>
          <Button size="1" variant="soft">
            Expand
          </Button>
        </Flex>
      </Card>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="4">
        {/* Header */}
        <Flex align="center" justify="between">
          <Text size="3" weight="medium">
            Create Context Template
          </Text>
          {onCancel && (
            <Button size="1" variant="ghost" onClick={onCancel}>
              <Cross2Icon />
            </Button>
          )}
        </Flex>

        <Separator size="4" />

        {/* Project Repo Section */}
        <ProjectRepoSelector
          repoName={repoName}
          onRepoNameChange={handleRepoNameChange}
          location={repoLocation}
          onLocationChange={setRepoLocation}
          error={repoError}
        />

        <Separator size="4" />

        {/* Parent Template Section */}
        <Box>
          <Text size="2" weight="medium" mb="2" style={{ display: "block" }}>
            Extends (Parent Template)
          </Text>
          <ParentTemplateSelector
            value={state.extends}
            onChange={setExtends}
          />

          {/* Inheritance chain visualization */}
          {state.extends && (
            <Box mt="3">
              <InheritanceChain
                chain={[state.extends]}
                currentName={repoName || "new template"}
              />
            </Box>
          )}
        </Box>

        <Separator size="4" />

        {/* Mount Points Section */}
        <Box>
          <Flex align="center" justify="between" mb="2">
            <Text size="2" weight="medium">
              Repositories
            </Text>
            <RepoSelector
              onSelect={handleAddRepo}
              excludeRepos={addedRepos}
            />
          </Flex>

          <MountPointList
            mountPoints={allMountPoints}
            errors={errors}
            onPathChange={updateMountPath}
            onRefChange={updateMountRef}
            onRemove={removeMountPoint}
            parentSpec={state.extends}
          />
        </Box>

        {/* Save Error */}
        {saveError && (
          <Callout.Root color="red" size="1">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>{saveError}</Callout.Text>
          </Callout.Root>
        )}

        {/* Actions */}
        <Flex gap="2" justify="end">
          {onCancel && (
            <Button variant="soft" color="gray" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button
            variant="solid"
            onClick={handleSave}
            disabled={saving || !repoName || !!repoError}
          >
            {saving ? (
              <>
                <Spinner size="1" />
                Creating...
              </>
            ) : (
              <>
                <CheckIcon />
                Create Project
              </>
            )}
          </Button>
        </Flex>

        {/* Template preview (debug) */}
        {templateSpec && (
          <Box
            p="2"
            style={{
              backgroundColor: "var(--gray-a2)",
              borderRadius: "var(--radius-2)",
              fontFamily: "monospace",
              fontSize: "var(--font-size-1)",
            }}
          >
            <Text size="1" color="gray">
              Template spec: {templateSpec}
            </Text>
          </Box>
        )}
      </Flex>
    </Card>
  );
}
