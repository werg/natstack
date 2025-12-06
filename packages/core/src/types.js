// Panel-to-Panel RPC Types
// Runtime contracts for communication between parent and child panels
// Generate a schema from method implementations (for runtime use)
export function inferSchema(methods) {
    const schema = { methods: {} };
    for (const [name, fn] of Object.entries(methods)) {
        // We can't truly infer types at runtime, so use 'any' for flexibility
        schema.methods[name] = {
            params: Array(fn.length).fill("any"),
            returns: "any",
        };
    }
    return schema;
}
// Validate a value against a schema type (basic runtime validation)
export function validateType(value, type) {
    switch (type) {
        case "any":
        case "void":
            return true;
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number";
        case "boolean":
            return typeof value === "boolean";
        case "object":
            return typeof value === "object" && value !== null;
        case "array":
            return Array.isArray(value);
        default:
            return true;
    }
}
//# sourceMappingURL=types.js.map