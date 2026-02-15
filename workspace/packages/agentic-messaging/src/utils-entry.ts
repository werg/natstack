/**
 * Subpath entry for lightweight utilities.
 *
 * Import via: import { ... } from "@workspace/agentic-messaging/utils"
 *
 * Contains general-purpose utilities and content type constants used
 * across panel and component code. Smaller than the full barrel.
 */

// JSON Schema utilities
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Content type constants
export {
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
} from "./responder-utils.js";

// Tool name utilities (lightweight - no Zod schemas)
export { extractMethodName, getCanonicalToolName, prettifyToolName } from "./tool-name-utils.js";
