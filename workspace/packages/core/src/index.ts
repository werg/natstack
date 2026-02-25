/**
 * @workspace/core - Minimal form-schema utility for workspace panels.
 *
 * Most functionality has been inlined into consuming packages.
 * This package now only provides form schema evaluation.
 */

// Form schema runtime functions
export {
  evaluateCondition,
  isFieldVisible,
  isFieldEnabled,
  getFieldWarning,
  groupFields,
  getFieldDefaults,
} from "./form-schema.js";
