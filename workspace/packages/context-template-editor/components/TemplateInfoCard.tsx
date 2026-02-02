/**
 * Displays context template info with optional edit mode.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Text,
  Flex,
  Card,
  Badge,
  Button,
  TextField,
  TextArea,
  Callout,
  Separator,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  Pencil1Icon,
  Cross2Icon,
  TrashIcon,
  LayersIcon,
  CubeIcon,
} from "@radix-ui/react-icons";
import type { TemplateInfo, ResolvedTemplate } from "../types";
import { ParentTemplateSelector } from "./ParentTemplateSelector";
import { RepoSelector } from "./RepoSelector";
import { useAvailableTemplates } from "../hooks/useAvailableTemplates";

interface TemplateInfoCardProps {
  /** Template info to display */
  info: TemplateInfo;
  /** Repo path for display */
  repoPath: string;
  /** Whether editing is allowed */
  editable?: boolean;
  /** Called when template is saved */
  onSave?: (info: TemplateInfo) => Promise<void>;
  /** Show status banner */
  showStatus?: boolean;
}

export function TemplateInfoCard({
  info,
  repoPath,
  editable = false,
  onSave,
  showStatus = true,
}: TemplateInfoCardProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedInfo, setEditedInfo] = useState<TemplateInfo>(info);
  const [parentStructure, setParentStructure] = useState<Record<string, string> | null>(null);
  const [loadingParent, setLoadingParent] = useState(false);

  const { loadTemplate } = useAvailableTemplates();

  // Load parent template structure when extends changes
  useEffect(() => {
    if (editedInfo.extends && editing) {
      setLoadingParent(true);
      loadTemplate(editedInfo.extends)
        .then((resolved) => {
          if (resolved?.structure) {
            setParentStructure(resolved.structure);
          } else {
            setParentStructure(null);
          }
        })
        .catch(() => setParentStructure(null))
        .finally(() => setLoadingParent(false));
    } else {
      setParentStructure(null);
    }
  }, [editedInfo.extends, editing, loadTemplate]);

  const handleSave = async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(editedInfo);
      setEditing(false);
    } catch (err) {
      console.error("Failed to save template:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedInfo(info);
    setParentStructure(null);
    setEditing(false);
  };

  const handleExtendsChange = (spec: string | undefined) => {
    setEditedInfo({ ...editedInfo, extends: spec });
  };

  const handleAddRepo = (repoSpec: string) => {
    // Generate a default mount path mirroring workspace structure
    const specWithoutRef = repoSpec.split("#")[0];
    const mountPath = `/workspace/${specWithoutRef}`;

    setEditedInfo({
      ...editedInfo,
      structure: {
        ...editedInfo.structure,
        [mountPath]: repoSpec,
      },
    });
  };

  const removeMountPoint = (path: string) => {
    const newStructure = { ...editedInfo.structure };
    delete newStructure[path];
    setEditedInfo({ ...editedInfo, structure: newStructure });
  };

  const updateMountPath = (oldPath: string, newPath: string) => {
    if (oldPath === newPath || !newPath.trim()) return;
    const spec = editedInfo.structure?.[oldPath];
    if (!spec) return;

    const newStructure = { ...editedInfo.structure };
    delete newStructure[oldPath];
    newStructure[newPath.trim()] = spec;
    setEditedInfo({ ...editedInfo, structure: newStructure });
  };

  const repoName = repoPath.split("/").pop() ?? repoPath;

  // Get list of already added repos (to exclude from selector)
  const addedRepos = Object.values(editedInfo.structure ?? {});

  if (editing) {
    return (
      <Card>
        <Flex direction="column" gap="3">
          <Flex justify="between" align="center">
            <Text size="2" weight="medium">
              Edit Template
            </Text>
            <Flex gap="2">
              <Button variant="soft" color="gray" size="1" onClick={handleCancel}>
                <Cross2Icon />
                Cancel
              </Button>
              <Button variant="solid" size="1" onClick={handleSave} disabled={saving}>
                <CheckCircledIcon />
                {saving ? "Saving..." : "Save"}
              </Button>
            </Flex>
          </Flex>

          {/* Name */}
          <Box>
            <Text size="1" color="gray" mb="1" style={{ display: "block" }}>
              Name
            </Text>
            <TextField.Root
              size="2"
              value={editedInfo.name ?? ""}
              onChange={(e) => setEditedInfo({ ...editedInfo, name: e.target.value })}
              placeholder={repoName}
            />
          </Box>

          {/* Description */}
          <Box>
            <Text size="1" color="gray" mb="1" style={{ display: "block" }}>
              Description
            </Text>
            <TextArea
              size="2"
              value={editedInfo.description ?? ""}
              onChange={(e) => setEditedInfo({ ...editedInfo, description: e.target.value })}
              placeholder="Optional description..."
              rows={2}
            />
          </Box>

          <Separator size="4" />

          {/* Extends - using ParentTemplateSelector */}
          <Box>
            <Text size="1" color="gray" mb="2" style={{ display: "block" }}>
              Extends (inherit from parent template)
            </Text>
            <ParentTemplateSelector
              value={editedInfo.extends}
              onChange={handleExtendsChange}
            />

            {/* Show inherited mount points when parent is selected */}
            {editedInfo.extends && (
              <Box mt="3" p="2" style={{ backgroundColor: "var(--gray-a2)", borderRadius: "var(--radius-2)" }}>
                <Flex align="center" gap="2" mb="2">
                  <LayersIcon color="var(--blue-9)" />
                  <Text size="1" color="gray" weight="medium">
                    Inherited from {editedInfo.extends.split("/").pop()}
                  </Text>
                </Flex>
                {loadingParent ? (
                  <Text size="1" color="gray">Loading inherited mounts...</Text>
                ) : parentStructure && Object.keys(parentStructure).length > 0 ? (
                  <Flex direction="column" gap="1">
                    {Object.entries(parentStructure).map(([path, spec]) => (
                      <Flex key={path} align="center" gap="2">
                        <CubeIcon color="var(--gray-8)" />
                        <Text size="1" style={{ fontFamily: "monospace" }} color="gray">
                          {path} → {spec}
                        </Text>
                        <Badge size="1" color="blue">inherited</Badge>
                      </Flex>
                    ))}
                  </Flex>
                ) : (
                  <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
                    No inherited mount points
                  </Text>
                )}
              </Box>
            )}
          </Box>

          <Separator size="4" />

          {/* Mount Points - this template's own mounts */}
          <Box>
            <Flex justify="between" align="center" mb="2">
              <Text size="1" color="gray">
                Additional Mount Points
              </Text>
              <RepoSelector
                onSelect={handleAddRepo}
                excludeRepos={addedRepos}
              />
            </Flex>

            {editedInfo.structure && Object.keys(editedInfo.structure).length > 0 ? (
              <Flex direction="column" gap="2">
                {Object.entries(editedInfo.structure).map(([path, spec]) => (
                  <Card key={path} size="1">
                    <Flex align="center" gap="2">
                      <CubeIcon color="var(--gray-9)" />
                      <Box style={{ flex: 1 }}>
                        <TextField.Root
                          size="1"
                          value={path}
                          onChange={(e) => updateMountPath(path, e.target.value)}
                          style={{ fontFamily: "monospace" }}
                        />
                      </Box>
                      <Text size="1" color="gray">→</Text>
                      <Text size="1" style={{ fontFamily: "monospace" }}>
                        {spec}
                      </Text>
                      <Button
                        variant="ghost"
                        color="red"
                        size="1"
                        onClick={() => removeMountPoint(path)}
                      >
                        <TrashIcon />
                      </Button>
                    </Flex>
                  </Card>
                ))}
              </Flex>
            ) : (
              <Card size="1">
                <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
                  No additional mount points. Click "Add Repository" to include repos.
                </Text>
              </Card>
            )}
          </Box>
        </Flex>
      </Card>
    );
  }

  // View mode
  return (
    <Card>
      <Flex direction="column" gap="3">
        {showStatus && (
          <Callout.Root size="1" color="green">
            <Callout.Icon>
              <CheckCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              Context template found. Ready to launch!
            </Callout.Text>
          </Callout.Root>
        )}

        {/* Template details */}
        <Box
          p="3"
          style={{
            backgroundColor: "var(--gray-a2)",
            borderRadius: "var(--radius-2)",
          }}
        >
          <Flex direction="column" gap="2">
            <Flex justify="between" align="center">
              <Text size="2" weight="medium">
                {info.name ?? repoName}
              </Text>
              {info.extends && (
                <Badge size="1" color="blue">
                  extends: {info.extends}
                </Badge>
              )}
            </Flex>

            {info.description && (
              <Text size="1" color="gray">
                {info.description}
              </Text>
            )}

            {info.structure && Object.keys(info.structure).length > 0 ? (
              <Box>
                <Text size="1" color="gray" mb="1" style={{ display: "block" }}>
                  Mount points:
                </Text>
                <Flex direction="column" gap="1">
                  {Object.entries(info.structure).map(([path, spec]) => (
                    <Text
                      key={path}
                      size="1"
                      style={{ fontFamily: "monospace" }}
                    >
                      {path} → {spec}
                    </Text>
                  ))}
                </Flex>
              </Box>
            ) : (
              <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
                No mount points configured
              </Text>
            )}
          </Flex>
        </Box>

        {/* Edit button */}
        {editable && onSave && (
          <Button variant="soft" size="2" onClick={() => setEditing(true)}>
            <Pencil1Icon />
            Edit Template
          </Button>
        )}
      </Flex>
    </Card>
  );
}
