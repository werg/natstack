/**
 * Subpath entry for lightweight utilities.
 *
 * Import via: import { ... } from "@natstack/agentic-messaging/utils"
 *
 * Contains general-purpose utilities and content type constants used
 * across panel and component code. Smaller than the full barrel.
 */

// JSON Schema utilities
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Content type constants (from protocol)
export {
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
} from "@natstack/agentic-protocol/content-types";

// Tool name utilities (from protocol, lightweight - no Zod schemas)
export { extractMethodName, getCanonicalToolName, prettifyToolName } from "@natstack/agentic-protocol/tool-name-utils";
