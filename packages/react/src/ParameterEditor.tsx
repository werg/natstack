/**
 * ParameterEditor Component
 *
 * Thin wrapper around FormRenderer for backwards compatibility.
 * Used by ns-about://agents (agent settings) and chat-launcher (agent setup).
 *
 * @deprecated Use FormRenderer directly for new code
 */

import type { FieldDefinition, FieldValue } from "@natstack/core";
import { groupFields } from "@natstack/core";
import { FormRenderer } from "./FormRenderer.js";

/**
 * Format slider value for display based on field definition hints.
 * Supports notched sliders, temperature-like decimals, and token counts.
 */
export function formatSliderValue(value: number, field: FieldDefinition): string {
  // If we have notches, find the matching notch label
  if (field.notches) {
    const notch = field.notches.find((n) => n.value === value);
    if (notch) return notch.label;
  }

  // Temperature-like slider (decimal step)
  if (field.step !== undefined && field.step < 1) {
    return value.toFixed(1);
  }

  // Token counts or large numbers
  if (field.max !== undefined && field.max >= 1000) {
    if (value === 0 && field.sliderLabels?.min === "Off") {
      return "Disabled";
    }
    return `${value.toLocaleString()} tokens`;
  }

  return String(value);
}

/**
 * Group parameters by their group field
 * @deprecated Use groupFields from @natstack/runtime
 */
export function groupParameters(
  parameters: FieldDefinition[]
): Map<string, FieldDefinition[]> {
  return groupFields(parameters);
}

export interface ParameterEditorProps {
  /** Parameter definitions to render */
  parameters: FieldDefinition[];
  /** Current values for each parameter */
  values: Record<string, FieldValue>;
  /** Callback when a value changes */
  onChange: (key: string, value: FieldValue) => void;
  /**
   * Size of form controls
   * @default "2"
   */
  size?: "1" | "2" | "3";
  /**
   * Whether to group parameters by their `group` field
   * @default true
   */
  showGroups?: boolean;
  /**
   * Whether to show required/optional indicators
   * @default false
   */
  showRequiredIndicators?: boolean;
  /**
   * Whether to stop click propagation on inputs
   * (useful when editor is inside a clickable container)
   * @default false
   */
  stopPropagation?: boolean;
}

/**
 * Renders a form for editing agent parameters.
 *
 * @deprecated Use FormRenderer directly for new code
 */
export function ParameterEditor({
  parameters,
  values,
  onChange,
  size = "2",
  showGroups = true,
  showRequiredIndicators = false,
  stopPropagation = false,
}: ParameterEditorProps) {
  return (
    <FormRenderer
      schema={parameters}
      values={values}
      onChange={onChange}
      size={size}
      showGroups={showGroups}
      showDescriptions={true}
      showRequiredIndicators={showRequiredIndicators}
      stopPropagation={stopPropagation}
    />
  );
}
