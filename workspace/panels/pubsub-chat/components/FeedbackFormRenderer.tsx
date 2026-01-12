/**
 * FeedbackFormRenderer Component
 *
 * Renders schema-based feedback forms using FormRenderer.
 * Handles submit/cancel/error callbacks and required field validation.
 */

import { useState, useCallback } from "react";
import { Box, Button, Flex, Heading } from "@radix-ui/themes";
import { FormRenderer } from "@natstack/react";
import type { FieldDefinition, FieldValue } from "@natstack/runtime";
import type { FeedbackComponentProps } from "../eval/feedbackUiTool";

export interface FeedbackFormRendererProps extends FeedbackComponentProps {
  title: string;
  fields: FieldDefinition[];
  initialValues?: Record<string, FieldValue>;
  submitLabel?: string;
  cancelLabel?: string;
}

export function FeedbackFormRenderer({
  title,
  fields,
  initialValues = {},
  submitLabel = "Save",
  cancelLabel = "Cancel",
  onSubmit,
  onCancel,
  onError,
}: FeedbackFormRendererProps) {
  // Initialize state with defaults merged with initial values
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const defaults: Record<string, FieldValue> = {};
    for (const field of fields) {
      if (field.default !== undefined) {
        defaults[field.key] = field.default;
      }
    }
    return { ...defaults, ...initialValues };
  });

  const handleChange = useCallback((key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    // Validate required fields
    for (const field of fields) {
      if (field.required) {
        const value = values[field.key];
        if (value === undefined || value === "") {
          onError(`Required field "${field.label}" is missing`);
          return;
        }
      }
    }
    onSubmit(values);
  }, [fields, values, onSubmit, onError]);

  return (
    <Box>
      <Heading size="4" mb="4">
        {title}
      </Heading>
      <Flex direction="column" gap="4">
        <FormRenderer
          schema={fields}
          values={values}
          onChange={handleChange}
          size="2"
          showGroups={true}
          showDescriptions={true}
          showRequiredIndicators={true}
        />
        <Flex gap="3" mt="2" justify="end">
          <Button variant="soft" color="gray" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button onClick={handleSubmit}>{submitLabel}</Button>
        </Flex>
      </Flex>
    </Box>
  );
}
