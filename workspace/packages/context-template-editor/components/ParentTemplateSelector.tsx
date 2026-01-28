/**
 * Selector for parent template (extends).
 */

import { Select, Text, Flex, Spinner } from "@radix-ui/themes";
import { useAvailableTemplates } from "../hooks/useAvailableTemplates";

interface ParentTemplateSelectorProps {
  /** Current selected parent spec */
  value: string | undefined;
  /** Called when selection changes */
  onChange: (spec: string | undefined) => void;
}

export function ParentTemplateSelector({ value, onChange }: ParentTemplateSelectorProps) {
  const { templates, loading, error } = useAvailableTemplates();

  const handleChange = (selected: string) => {
    if (selected === "none") {
      onChange(undefined);
    } else {
      onChange(selected);
    }
  };

  if (loading) {
    return (
      <Flex align="center" gap="2">
        <Spinner size="1" />
        <Text size="2" color="gray">
          Loading templates...
        </Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Text size="2" color="red">
        {error}
      </Text>
    );
  }

  return (
    <Select.Root value={value ?? "none"} onValueChange={handleChange}>
      <Select.Trigger style={{ minWidth: 200 }} />
      <Select.Content>
        <Select.Item value="none">
          <Text size="2">No parent template</Text>
        </Select.Item>
        {templates.length > 0 && (
          <>
            <Select.Separator />
            <Select.Group>
              <Select.Label>Base Templates</Select.Label>
              {templates.map((template) => (
                <Select.Item key={template.spec} value={template.spec}>
                  <Flex direction="column">
                    <Text size="2">{template.name}</Text>
                    <Text size="1" color="gray">
                      {template.spec}
                    </Text>
                  </Flex>
                </Select.Item>
              ))}
            </Select.Group>
          </>
        )}
      </Select.Content>
    </Select.Root>
  );
}
