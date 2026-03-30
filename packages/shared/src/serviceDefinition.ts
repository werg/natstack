import { z } from "zod";
import type { ServicePolicy } from "./servicePolicy.js";
import type { ServiceHandler } from "./serviceDispatcher.js";

export interface MethodDef {
  description?: string;
  args: z.ZodType;
  returns?: z.ZodType;
  policy?: ServicePolicy;
}

export interface ServiceDefinition {
  name: string;
  description?: string;
  policy: ServicePolicy;
  methods: Record<string, MethodDef>;
  handler: ServiceHandler;
}
