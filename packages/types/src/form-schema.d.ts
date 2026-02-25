/**
 * Form Schema Types - Data-driven UI definition system.
 *
 * Type definitions for forms defined via data, with support for
 * conditionality between fields.
 *
 * Runtime functions (evaluateCondition, isFieldVisible, etc.) live in @workspace/core (form-schema only).
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
export type FieldType = "string" | "number" | "boolean" | "select" | "slider" | "segmented" | "toggle" | "readonly" | "code" | "buttonGroup" | "multiSelect" | "diff" | "toolPreview" | "approvalHeader";
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
    key: string;
    label?: string;
    description?: string;
    type: FieldType;
    required?: boolean;
    default?: FieldValue;
    channelLevel?: boolean;
    options?: FieldOption[];
    variant?: "buttons" | "cards" | "list";
    min?: number;
    max?: number;
    step?: number;
    notches?: SliderNotch[];
    sliderLabels?: {
        min?: string;
        max?: string;
    };
    group?: string;
    order?: number;
    visibleWhen?: FieldCondition | FieldCondition[];
    enabledWhen?: FieldCondition | FieldCondition[];
    warnings?: FieldWarning[];
    placeholder?: string;
    language?: string;
    maxHeight?: number;
    buttonStyle?: "outline" | "solid" | "soft";
    buttons?: Array<{
        value: string;
        label: string;
        color?: "gray" | "green" | "red" | "amber";
        description?: string;
    }>;
    submitOnSelect?: boolean;
    toolName?: string;
    toolArgs?: unknown;
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
//# sourceMappingURL=form-schema.d.ts.map