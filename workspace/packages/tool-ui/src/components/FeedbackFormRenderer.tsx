/**
 * FeedbackFormRenderer Component
 *
 * Renders schema-based feedback forms using FormRenderer.
 * Handles submit/cancel/error callbacks and required field validation.
 * Supports timeout, severity, and hide submit/cancel options.
 *
 * Custom field types:
 * - toolPreview: Rich previews (Monaco diffs, git previews, etc.) via ToolPreviewField
 * - approvalHeader: Tool approval header (first-time grant or per-call) via ApprovalHeaderField
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Box, Button, Flex, Heading } from "@radix-ui/themes";
import { InfoCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { FormRenderer, type CustomFieldRendererProps } from "@workspace/react";
import type { FieldDefinition, FieldValue } from "@natstack/types";
import type { FeedbackComponentProps } from "../types";
import { ToolPreviewField } from "./ToolPreviewField";
import { ApprovalHeaderField } from "./ApprovalHeaderField";

export interface FeedbackFormRendererProps extends FeedbackComponentProps {
  title: string;
  fields: FieldDefinition[];
  initialValues?: Record<string, FieldValue>;
  submitLabel?: string;
  cancelLabel?: string;
  timeout?: number;
  timeoutAction?: "cancel" | "submit";
  severity?: "info" | "warning" | "danger";
  hideSubmit?: boolean;
  hideCancel?: boolean;
}

/**
 * Get the icon for a severity level
 */
function getSeverityIcon(severity: "info" | "warning" | "danger" | undefined) {
  switch (severity) {
    case "danger":
    case "warning":
      return <ExclamationTriangleIcon />;
    default:
      return <InfoCircledIcon />;
  }
}

/**
 * Get the color for a severity level
 */
function getSeverityColor(severity: "info" | "warning" | "danger" | undefined): "blue" | "amber" | "red" {
  switch (severity) {
    case "danger":
      return "red";
    case "warning":
      return "amber";
    default:
      return "blue";
  }
}

export function FeedbackFormRenderer({
  title,
  fields,
  initialValues = {},
  submitLabel = "Save",
  cancelLabel = "Cancel",
  timeout,
  timeoutAction = "cancel",
  severity,
  hideSubmit = false,
  hideCancel = false,
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

  // Track latest values for timeout handler
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const handleChange = useCallback((key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    // Validate required fields
    for (const field of fields) {
      if (field.required) {
        const value = valuesRef.current[field.key];
        if (value === undefined || value === "") {
          onError(`Required field "${field.label}" is missing`);
          return;
        }
      }
    }
    onSubmit(valuesRef.current);
  }, [fields, onSubmit, onError]);

  // Handle timeout
  useEffect(() => {
    if (!timeout || timeout <= 0) return;

    const timer = setTimeout(() => {
      if (timeoutAction === "submit") {
        handleSubmit();
      } else {
        onCancel();
      }
    }, timeout);

    return () => clearTimeout(timer);
  }, [timeout, timeoutAction, handleSubmit, onCancel]);

  // Check if we should show any buttons
  const showButtons = !hideSubmit || !hideCancel;

  // Don't show title if we have an approvalHeader field (header contains its own title)
  const hasApprovalHeader = fields.some(f => f.type === "approvalHeader");
  const showTitle = !hasApprovalHeader && title;

  // Custom field renderers for toolPreview and approvalHeader fields
  const customFieldRenderers = useMemo(() => ({
    toolPreview: ({ field, theme }: CustomFieldRendererProps) => (
      <ToolPreviewField
        toolName={field.toolName ?? "unknown"}
        args={field.toolArgs}
        theme={theme}
      />
    ),
    approvalHeader: ({ field }: CustomFieldRendererProps) => (
      <ApprovalHeaderField
        agentName={field.agentName ?? "unknown"}
        toolName={field.toolName ?? "unknown"}
        displayName={field.displayName}
        isFirstTimeGrant={field.isFirstTimeGrant ?? false}
        floorLevel={field.floorLevel ?? 1}
      />
    ),
  }), []);

  return (
    <Box>
      {/* Title with optional severity icon (hidden when approvalHeader is used) */}
      {showTitle && (
        <Flex align="center" gap="2" mb="4">
          {severity && getSeverityIcon(severity)}
          <Heading size="4">{title}</Heading>
        </Flex>
      )}

      <Flex direction="column" gap="4">
        <FormRenderer
          schema={fields}
          values={values}
          onChange={handleChange}
          onSubmit={handleSubmit}
          size="2"
          showGroups={true}
          showDescriptions={true}
          showRequiredIndicators={true}
          customFieldRenderers={customFieldRenderers}
          theme="dark"
        />

        {showButtons && (
          <Flex gap="3" mt="2" justify="end">
            {!hideCancel && (
              <Button variant="soft" color="gray" onClick={onCancel}>
                {cancelLabel}
              </Button>
            )}
            {!hideSubmit && (
              <Button color={severity ? getSeverityColor(severity) : undefined} onClick={handleSubmit}>
                {submitLabel}
              </Button>
            )}
          </Flex>
        )}
      </Flex>
    </Box>
  );
}
