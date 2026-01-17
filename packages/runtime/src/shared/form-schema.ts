/**
 * Form Schema - Data-driven UI definition system
 *
 * Provides types and utilities for defining forms via data,
 * with support for conditionality between fields.
 *
 * Used by:
 * - Agent configuration (pre-connection and runtime settings)
 * - Any data-driven form in panels or workers
 */

/**
 * Primitive value types (used in conditions and warnings)
 */
export type PrimitiveFieldValue = string | number | boolean;

/**
 * Value types supported by form fields
 * - Primitives: string, number, boolean
 * - Arrays: string[] (for multiSelect fields)
 */
export type FieldValue = PrimitiveFieldValue | string[];

/**
 * Field types supported by the form renderer
 */
export type FieldType =
  // Standard form types
  | "string" // Text input
  | "number" // Numeric input
  | "boolean" // Switch/toggle
  | "select" // Dropdown
  | "slider" // Range slider (continuous or notched)
  | "segmented" // Segmented control (mutually exclusive options)
  | "toggle" // Two-state toggle with explicit labels
  // Feedback UI types
  | "readonly" // Display-only text (non-editable)
  | "code" // Syntax-highlighted code/JSON block
  | "buttonGroup" // Horizontal action buttons (Allow/Deny style)
  | "multiSelect" // Multiple selection checkboxes
  | "diff" // Unified or side-by-side diff view
  | "toolPreview" // Rich tool argument preview (Monaco diff, git previews, etc.)
  | "approvalHeader"; // Tool approval header (first-time grant or per-call)

/**
 * Comparison operators for field conditions
 */
export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";

/**
 * Condition for field visibility/enabled state
 *
 * @example Show "autonomyLevel" slider only when "mode" equals "edit"
 * { field: "mode", operator: "eq", value: "edit" }
 */
export interface FieldCondition {
  field: string;
  operator: ConditionOperator;
  value: PrimitiveFieldValue | PrimitiveFieldValue[];
}

/**
 * Option for select/segmented/toggle fields
 */
export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Notch definition for slider fields.
 * Allows discrete labeled stops on a continuous slider.
 */
export interface SliderNotch {
  value: number;
  label: string;
  description?: string;
}

/**
 * Warning to display when field has a specific value
 */
export interface FieldWarning {
  when: PrimitiveFieldValue | PrimitiveFieldValue[];
  message: string;
  severity?: "info" | "warning" | "danger";
}

/**
 * Complete field definition
 */
export interface FieldDefinition {
  // Identity
  key: string;
  label?: string; // Optional - some field types (toolPreview, buttonGroup) have built-in headers
  description?: string;

  // Type and behavior
  type: FieldType;
  required?: boolean;
  default?: FieldValue;

  // Options (for select, segmented, toggle)
  options?: FieldOption[];

  // Slider configuration
  min?: number;
  max?: number;
  step?: number;
  notches?: SliderNotch[]; // Discrete labeled stops
  sliderLabels?: { min?: string; max?: string };

  // Layout
  group?: string;
  order?: number;

  // Conditionality
  visibleWhen?: FieldCondition | FieldCondition[]; // AND logic for arrays
  enabledWhen?: FieldCondition | FieldCondition[];

  // Validation and warnings
  warnings?: FieldWarning[];
  placeholder?: string;

  // Feedback UI field properties

  // For code/readonly/diff fields
  language?: string; // "typescript", "json", "bash", "diff"
  maxHeight?: number; // Max scrollable height in px

  // For buttonGroup fields
  buttonStyle?: "outline" | "solid" | "soft";
  buttons?: Array<{
    value: string;
    label: string;
    color?: "gray" | "green" | "red" | "amber";
    description?: string;
  }>;

  // For select/multiSelect/buttonGroup - auto-submit when selected
  submitOnSelect?: boolean;

  // For toolPreview fields
  toolName?: string; // Name of the tool (e.g., "file_edit", "git_commit")
  toolArgs?: unknown; // Tool input arguments to preview

  // For approvalHeader fields
  agentName?: string; // Name of the agent requesting access
  displayName?: string; // Display name for the tool (e.g., "Edit" for file_edit)
  isFirstTimeGrant?: boolean; // Whether this is a first-time grant (vs per-call)
  floorLevel?: number; // Current approval level (0=Ask All, 1=Auto-Safe, 2=Full Auto)
}

/**
 * Complete form schema
 */
export interface FormSchema {
  fields: FieldDefinition[];
  title?: string;
  description?: string;
}

/**
 * Evaluate a single condition against current form values
 */
export function evaluateCondition(
  condition: FieldCondition,
  values: Record<string, FieldValue>
): boolean {
  const fieldValue = values[condition.field];
  const conditionValue = condition.value;

  switch (condition.operator) {
    case "eq":
      return fieldValue === conditionValue;
    case "neq":
      return fieldValue !== conditionValue;
    case "gt":
      return typeof fieldValue === "number" && typeof conditionValue === "number" && fieldValue > conditionValue;
    case "gte":
      return typeof fieldValue === "number" && typeof conditionValue === "number" && fieldValue >= conditionValue;
    case "lt":
      return typeof fieldValue === "number" && typeof conditionValue === "number" && fieldValue < conditionValue;
    case "lte":
      return typeof fieldValue === "number" && typeof conditionValue === "number" && fieldValue <= conditionValue;
    case "in":
      // "in" operator only applies to primitive field values (not arrays like multiSelect)
      if (Array.isArray(fieldValue) || fieldValue === undefined) return false;
      return Array.isArray(conditionValue) && conditionValue.includes(fieldValue);
    default:
      return false;
  }
}

/**
 * Evaluate an array of conditions (AND logic)
 */
function evaluateConditions(
  conditions: FieldCondition | FieldCondition[] | undefined,
  values: Record<string, FieldValue>
): boolean {
  if (!conditions) return true;
  if (Array.isArray(conditions)) {
    return conditions.every((c) => evaluateCondition(c, values));
  }
  return evaluateCondition(conditions, values);
}

/**
 * Check if a field should be visible based on its visibleWhen condition
 */
export function isFieldVisible(field: FieldDefinition, values: Record<string, FieldValue>): boolean {
  return evaluateConditions(field.visibleWhen, values);
}

/**
 * Check if a field should be enabled based on its enabledWhen condition
 */
export function isFieldEnabled(field: FieldDefinition, values: Record<string, FieldValue>): boolean {
  return evaluateConditions(field.enabledWhen, values);
}

/**
 * Get the active warning for a field based on its current value
 */
export function getFieldWarning(field: FieldDefinition, value: FieldValue): FieldWarning | null {
  if (!field.warnings) return null;
  // Warnings only apply to primitive values (not arrays like multiSelect)
  if (Array.isArray(value)) return null;

  for (const warning of field.warnings) {
    if (Array.isArray(warning.when)) {
      if (warning.when.includes(value)) return warning;
    } else if (warning.when === value) {
      return warning;
    }
  }
  return null;
}

/**
 * Group fields by their group property
 */
export function groupFields(fields: FieldDefinition[]): Map<string, FieldDefinition[]> {
  const groups = new Map<string, FieldDefinition[]>();

  for (const field of fields) {
    const groupName = field.group ?? "General";
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }
    groups.get(groupName)!.push(field);
  }

  // Sort fields within each group by order
  for (const groupFields of groups.values()) {
    groupFields.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }

  return groups;
}

/**
 * Get default values from field definitions
 */
export function getFieldDefaults(fields: FieldDefinition[]): Record<string, FieldValue> {
  const defaults: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.default !== undefined) {
      defaults[field.key] = field.default;
    }
  }
  return defaults;
}
