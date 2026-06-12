import type { ServicePolicy } from "./servicePolicy.js";
import type { ServiceHandler } from "./serviceDispatcher.js";
import type { MethodSchema } from "./typedServiceClient.js";

export interface ServiceDefinition {
  name: string;
  description?: string;
  policy: ServicePolicy;
  /**
   * Method schema table — pure data (Zod arg tuples, optional return schemas,
   * per-method policies). For services with external callers this should be a
   * shared table from `serviceSchemas/` so typed clients derive their types
   * from the same source of truth (see typedServiceClient.ts).
   */
  methods: Record<string, MethodSchema>;
  handler: ServiceHandler;
}
