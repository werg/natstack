/**
 * Template info section for managed projects.
 * Shows context template info with edit capability.
 */

import { useState, useEffect, useCallback } from "react";
import { Box, Text, Card, Flex, Spinner } from "@radix-ui/themes";
import { ChevronDownIcon, ChevronRightIcon, FileTextIcon } from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";
import { TemplateInfoCard, type TemplateInfo } from "@workspace/context-template-editor";

interface TemplateSectionProps {
  /** The repo path containing the context template */
  repoPath: string;
  /** Whether the section is expanded */
  expanded: boolean;
  /** Toggle expansion */
  onToggle: () => void;
}

export function TemplateSection({ repoPath, expanded, onToggle }: TemplateSectionProps) {
  const [templateInfo, setTemplateInfo] = useState<TemplateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load template info
  const loadTemplate = useCallback(async () => {
    if (!repoPath) {
      setTemplateInfo(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const info = await rpc.call<TemplateInfo | null>(
        "main",
        "bridge.loadContextTemplate",
        repoPath
      );
      setTemplateInfo(info);
    } catch (err) {
      console.error("Failed to load template:", err);
      setError(err instanceof Error ? err.message : "Failed to load template");
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void loadTemplate();
  }, [loadTemplate]);

  // Save template changes
  const handleSave = async (updatedInfo: TemplateInfo) => {
    try {
      await rpc.call("main", "bridge.saveContextTemplate", repoPath, updatedInfo);
      setTemplateInfo(updatedInfo);
    } catch (err) {
      console.error("Failed to save template:", err);
      throw err;
    }
  };

  return (
    <Card size="1">
      <Flex
        align="center"
        gap="2"
        tabIndex={0}
        style={{ cursor: "pointer" }}
        onClick={onToggle}
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <FileTextIcon />
        <Text size="2" weight="medium">
          Context Template
        </Text>
      </Flex>

      {expanded && (
        <Box mt="3">
          {loading ? (
            <Flex align="center" gap="2" p="2">
              <Spinner size="1" />
              <Text size="2" color="gray">
                Loading template...
              </Text>
            </Flex>
          ) : error ? (
            <Text size="2" color="red">
              {error}
            </Text>
          ) : templateInfo ? (
            <TemplateInfoCard
              info={templateInfo}
              repoPath={repoPath}
              editable={true}
              onSave={handleSave}
              showStatus={false}
            />
          ) : (
            <Text size="2" color="gray">
              No context template found
            </Text>
          )}
        </Box>
      )}
    </Card>
  );
}
