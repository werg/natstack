import type { JSONSchema7 } from "json-schema";

/**
 * JSON Schema type for stateArgs declaration in manifest.
 * We use draft-07 only (Ajv v8 default, most widely supported).
 */
export type StateArgsSchema = JSONSchema7;

/**
 * Runtime state args value - the actual data.
 */
export type StateArgsValue = Record<string, unknown>;

/**
 * Validation result from Ajv.
 */
export interface StateArgsValidation {
  success: boolean;
  data?: StateArgsValue;
  error?: string;
}
