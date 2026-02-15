/**
 * Form Schema Types - Data-driven UI definition system.
 *
 * Type definitions for forms defined via data, with support for
 * conditionality between fields.
 *
 * Runtime functions (evaluateCondition, isFieldVisible, etc.) live in @workspace/core.
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
export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

/**
 * Condition for field visibility/enabled state
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
  label?: string;
  description?: string;

  // Type and behavior
  type: FieldType;
  required?: boolean;
  default?: FieldValue;
  channelLevel?: boolean;

  // Options (for select, segmented, toggle, multiSelect)
  options?: FieldOption[];

  // Variant for segmented and multiSelect fields
  variant?: "buttons" | "cards" | "list";

  // Slider configuration
  min?: number;
  max?: number;
  step?: number;
  notches?: SliderNotch[];
  sliderLabels?: { min?: string; max?: string };

  // Layout
  group?: string;
  order?: number;

  // Conditionality
  visibleWhen?: FieldCondition | FieldCondition[];
  enabledWhen?: FieldCondition | FieldCondition[];

  // Validation and warnings
  warnings?: FieldWarning[];
  placeholder?: string;

  // Feedback UI field properties
  language?: string;
  maxHeight?: number;

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
  toolName?: string;
  toolArgs?: unknown;

  // For approvalHeader fields
  agentName?: string;
  displayName?: string;
  isFirstTimeGrant?: boolean;
  floorLevel?: number;
}

/**
 * Complete form schema
 */
export interface FormSchema {
  fields: FieldDefinition[];
  title?: string;
  description?: string;
}
