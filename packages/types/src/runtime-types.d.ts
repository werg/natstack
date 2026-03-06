/**
 * Runtime Types - Core type definitions used by the app from @workspace/runtime.
 *
 * eventSchemas is typed as `unknown` here to avoid a zod dependency.
 * The app never uses this field directly.
 */
export interface CreateChildOptions {
    name?: string;
    env?: Record<string, string>;
    /** Typed as unknown to avoid zod dependency. At runtime this is EventSchemaMap (Record<string, ZodType>). */
    eventSchemas?: unknown;
    focus?: boolean;
    contextId?: string;
}
export interface ChildCreationResult {
    id: string;
}
export interface ChildSpec {
    name?: string;
    env?: Record<string, string>;
    source: string;
    eventSchemas?: unknown;
}
//# sourceMappingURL=runtime-types.d.ts.map
