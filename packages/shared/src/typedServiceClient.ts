/**
 * Typed service client — derives a fully typed call surface from a service's
 * Zod method schema table.
 *
 * Service method tables (`packages/shared/src/serviceSchemas/<service>.ts`)
 * are the single source of truth for a service's wire contract: argument
 * tuples, optional return schemas, and per-method policies. The server
 * attaches handlers to them; clients derive their types from them. Nothing
 * is hand-duplicated.
 *
 * - Argument types come from `z.infer` of the method's `args` tuple, with
 *   trailing `| undefined` elements relaxed to optional parameters so
 *   `client.logs("unit")` works when the options argument is optional.
 * - Return types come from `z.infer` of the method's `returns` schema when
 *   declared, `unknown` otherwise (callers should add `returns` schemas
 *   rather than cast).
 * - Dotted method names (`"units.list"`) become nested objects
 *   (`client.units.list(...)`).
 */

import type { z } from "zod";
import type { ServicePolicy } from "./servicePolicy.js";

/** Pure-data schema for one RPC method (no handler — that's server-side). */
export interface MethodSchema {
  description?: string;
  args: z.ZodType;
  returns?: z.ZodType;
  policy?: ServicePolicy;
}

export type ServiceMethodSchemas = Record<string, MethodSchema>;

/**
 * Identity helper that preserves the literal key/schema types of a method
 * table for client derivation while checking the table's shape.
 */
export function defineServiceMethods<const M extends ServiceMethodSchemas>(methods: M): M {
  return methods;
}

/**
 * Relax trailing tuple elements that accept `undefined` into optional
 * parameters. Zod infers `z.tuple([A, B.optional()])` as `[A, B | undefined]`,
 * which would force callers to pass `undefined` explicitly.
 */
export type ArgsOf<T> = T extends readonly [...infer Rest, infer Last]
  ? undefined extends Last
    ? [...ArgsOf<Rest>, Last?]
    : [...Rest, Last]
  : T extends readonly unknown[]
    ? T // open-ended tuple (z.tuple(...).rest(...)) — pass through as-is
    : [];

type MethodResult<D extends MethodSchema> = D["returns"] extends z.ZodType
  ? z.infer<D["returns"]>
  : unknown;

export type MethodFn<D extends MethodSchema> = (
  ...args: ArgsOf<z.infer<D["args"]>>
) => Promise<MethodResult<D>>;

/** The sub-table of methods under a dotted prefix (`"units."` → list, logs, …). */
type SubMethods<M extends ServiceMethodSchemas, H extends string> = {
  [K in keyof M & string as K extends `${H}.${infer Rest}` ? Rest : never]: M[K];
};

/**
 * Typed call surface for a method table: plain names become methods, dotted
 * names become nested groups.
 */
export type TypedServiceClient<M extends ServiceMethodSchemas> = {
  [K in keyof M & string as K extends `${infer Head}.${string}` ? Head : K]: K extends
    `${infer Head}.${string}`
    ? TypedServiceClient<SubMethods<M, Head>>
    : MethodFn<M[K]>;
};

/** Transport-agnostic call signature: `(service, method, args) → result`. */
export type ServiceCallFn = (service: string, method: string, args: unknown[]) => Promise<unknown>;

/**
 * Build the typed client object for a service. The object is constructed
 * eagerly (no Proxy) so it's enumerable and debuggable; each leaf forwards to
 * `call(service, "<full.method.name>", args)`.
 */
export function createTypedServiceClient<M extends ServiceMethodSchemas>(
  service: string,
  methods: M,
  call: ServiceCallFn
): TypedServiceClient<M> {
  const root: Record<string, unknown> = {};
  for (const fullName of Object.keys(methods)) {
    const segments = fullName.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = (node[segment] ??= {});
      if (typeof next !== "object" || next === null) {
        throw new Error(
          `Service "${service}" method "${fullName}" collides with non-group method "${segment}"`
        );
      }
      node = next as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1]!;
    if (node[leaf] !== undefined) {
      throw new Error(`Service "${service}" method "${fullName}" collides with group "${leaf}"`);
    }
    node[leaf] = (...args: unknown[]) => call(service, fullName, args);
  }
  return root as TypedServiceClient<M>;
}
