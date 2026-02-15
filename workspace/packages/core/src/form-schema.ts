/**
 * Form Schema - Data-driven UI definition system
 *
 * Types are canonical in @natstack/types. Re-exported here for backward compat.
 * Runtime functions (evaluateCondition, isFieldVisible, etc.) live here.
 */

import type { FieldCondition, FieldValue, FieldDefinition, FieldWarning, PrimitiveFieldValue } from "@natstack/types";

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
      if (Array.isArray(fieldValue) || fieldValue === undefined) return false;
      return Array.isArray(conditionValue) && conditionValue.includes(fieldValue);
    case "contains":
      if (!Array.isArray(fieldValue)) return false;
      return fieldValue.includes(conditionValue as string);
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
  if (Array.isArray(value)) return null;

  for (const warning of field.warnings) {
    if (Array.isArray(warning.when)) {
      if (warning.when.includes(value as PrimitiveFieldValue)) return warning;
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
