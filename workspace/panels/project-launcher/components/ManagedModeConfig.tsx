/**
 * Configuration for managed workspace mode.
 * Allows selecting a context template from the workspace.
 *
 * Note: Context templates are defined by directories containing context-template.yml.
 * The user selects a pre-defined template rather than individual repos.
 */

import { useState, useEffect } from "react";
import { Box, Text, Flex, Card, Spinner, RadioGroup, Callout } from "@radix-ui/themes";
import { FileIcon, InfoCircledIcon } from "@radix-ui/react-icons";
import { rpc } from "@natstack/runtime";

/** WorkspaceNode from the tree API */
interface WorkspaceNode {
  name: string;
  path: string;
  type: "directory" | "git-repo";
  natstack?: { type: string; title: string };
  children: WorkspaceNode[];
}

/** WorkspaceTree from bridge.getWorkspaceTree */
interface WorkspaceTree {
  children: WorkspaceNode[];
}

/** Context template info */
interface ContextTemplate {
  path: string;
  name: string;
}

interface ManagedModeConfigProps {
  includedRepos: string[];
  onIncludedReposChange: (repos: string[]) => void;
  onContextTemplateSpecChange: (spec: string) => void;
}

/**
 * Recursively find context templates in the workspace tree.
 * Context templates are directories in "contexts/" that contain context-template.yml
 */
function findContextTemplates(nodes: WorkspaceNode[], parentPath = ""): ContextTemplate[] {
  const templates: ContextTemplate[] = [];

  for (const node of nodes) {
    const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;

    // Check if this is in the contexts directory and is a git repo (templates are versioned)
    if (nodePath.startsWith("contexts/") && node.type === "git-repo") {
      templates.push({
        path: nodePath,
        name: node.name,
      });
    }

    // Recurse into children
    if (node.children.length > 0) {
      templates.push(...findContextTemplates(node.children, nodePath));
    }
  }

  return templates;
}

export function ManagedModeConfig({
  includedRepos,
  onIncludedReposChange,
  onContextTemplateSpecChange,
}: ManagedModeConfigProps) {
  const [templates, setTemplates] = useState<ContextTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadTemplates() {
      try {
        setLoading(true);
        const tree = await rpc.call<WorkspaceTree>("main", "bridge.getWorkspaceTree");
        const found = findContextTemplates(tree.children);
        setTemplates(found);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load workspace");
        setTemplates([]);
      } finally {
        setLoading(false);
      }
    }
    void loadTemplates();
  }, []);

  // Update context template spec when selection changes
  const handleTemplateChange = (templatePath: string) => {
    setSelectedTemplate(templatePath);
    onContextTemplateSpecChange(templatePath);
    // Store the template path as the single "included repo" for display purposes
    onIncludedReposChange(templatePath ? [templatePath] : []);
  };

  if (loading) {
    return (
      <Flex align="center" justify="center" py="4">
        <Spinner size="2" />
        <Text size="2" color="gray" ml="2">
          Loading templates...
        </Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Box>
        <Text size="2" color="red">
          {error}
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Select Context Template
      </Text>

      <Callout.Root size="1" color="gray" mb="3">
        <Callout.Icon>
          <InfoCircledIcon />
        </Callout.Icon>
        <Callout.Text>
          Context templates define the filesystem environment for managed sessions.
          Templates are located in the <code>contexts/</code> directory.
        </Callout.Text>
      </Callout.Root>

      {templates.length === 0 ? (
        <Card size="1">
          <Text size="2" color="gray">
            No context templates found. Create a template in <code>contexts/</code> with a{" "}
            <code>context-template.yml</code> file.
          </Text>
        </Card>
      ) : (
        <RadioGroup.Root value={selectedTemplate} onValueChange={handleTemplateChange}>
          <Flex direction="column" gap="2">
            {templates.map((template) => (
              <Card key={template.path} size="1" asChild>
                <label style={{ cursor: "pointer" }}>
                  <Flex align="center" gap="2">
                    <RadioGroup.Item value={template.path} />
                    <FileIcon />
                    <Box>
                      <Text size="2" weight="medium">
                        {template.name}
                      </Text>
                      <Text size="1" color="gray">
                        {template.path}
                      </Text>
                    </Box>
                  </Flex>
                </label>
              </Card>
            ))}
          </Flex>
        </RadioGroup.Root>
      )}
    </Box>
  );
}
