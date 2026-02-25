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

// Content type constants (from protocol)
export {
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
} from "@workspace/agentic-protocol/content-types";

// Tool name utilities (from protocol, lightweight - no Zod schemas)
export { extractMethodName, getCanonicalToolName, prettifyToolName } from "@workspace/agentic-protocol/tool-name-utils";
