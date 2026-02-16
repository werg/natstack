/**
 * @workspace/core - Core runtime utilities shared between runtime and agent-runtime.
 *
 * This package provides runtime functions for:
 * - IPC protocol type guards
 * - Form schema evaluation (visibility, conditions, defaults)
 * - Database client creation
 * - Base64 utilities
 *
 * Types have been moved to @natstack/types (canonical source).
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

// Database client
export { createDbClient } from "./database.js";

// Base64 utilities
export { encodeBase64, decodeBase64 } from "./base64.js";
