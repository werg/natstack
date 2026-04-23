import z from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { AuditLog } from "@natstack/shared/credentials/audit";
import type { AuditEntry } from "@natstack/shared/credentials/types";

const auditQuerySchema = z.object({
  filter: z.object({
    workerId: z.string().optional(),
    providerId: z.string().optional(),
    connectionId: z.string().optional(),
    method: z.string().optional(),
  }).optional(),
  limit: z.number().int().positive().optional(),
  after: z.number().optional(),
});

type AuditQuery = {
  filter?: Partial<Pick<AuditEntry, "workerId" | "providerId" | "connectionId" | "method">>;
  limit?: number;
  after?: number;
};

export function createAuditService(auditLog: AuditLog): ServiceDefinition {
  return {
    name: "audit",
    description: "Audit log query access",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      query: {
        args: z.tuple([auditQuerySchema.optional()]),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "query":
          return auditLog.query(args[0] as AuditQuery | undefined);
        default:
          throw new Error(`Unknown audit method: ${method}`);
      }
    },
  };
}

export { AuditLog };
