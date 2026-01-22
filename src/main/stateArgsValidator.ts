import Ajv from "ajv";
import type { StateArgsSchema, StateArgsValue, StateArgsValidation } from "../shared/stateArgs.js";

// Ajv instance with defaults enabled - mutates input to apply defaults
const ajv = new Ajv({ useDefaults: true, coerceTypes: true });

// Cache compiled validators per schema
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

/**
 * Get or create a compiled validator for a schema.
 */
function getValidator(schema: StateArgsSchema) {
  const key = JSON.stringify(schema);
  let validator = validatorCache.get(key);
  if (!validator) {
    validator = ajv.compile(schema);
    validatorCache.set(key, validator);
  }
  return validator;
}

/**
 * Validate state args against manifest schema.
 * Returns validated data (with defaults applied) or errors.
 *
 * Note: Ajv mutates the input to apply defaults, so we clone first.
 */
export function validateStateArgs(
  args: unknown,
  schema: StateArgsSchema | undefined
): StateArgsValidation {
  // First, ensure input is JSON-serializable (catches functions, circular refs, etc.)
  let data: StateArgsValue;
  try {
    data = JSON.parse(JSON.stringify(args ?? {}));
  } catch {
    return { success: false, error: "stateArgs must be JSON-serializable" };
  }

  // No schema = accept any JSON-serializable value
  if (!schema) {
    return { success: true, data };
  }

  // Validate against schema (Ajv applies defaults in-place to `data`)
  const validator = getValidator(schema);
  const valid = validator(data);

  if (valid) {
    return { success: true, data };
  } else {
    const errors = validator.errors?.map((e) => `${e.instancePath} ${e.message}`).join("; ");
    return { success: false, error: errors ?? "Validation failed" };
  }
}
