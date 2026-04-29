import z from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { AuditLog } from "@natstack/shared/credentials/audit";
import type { AuditEntry, CredentialAuditEvent } from "@natstack/shared/credentials/types";

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

/**
 * SECURITY (#28 in audit report): strip query strings, fragments, and
 * userinfo from URLs before persisting / returning them in audit
 * entries. Bearer tokens, OAuth `code`/`access_token`/`token` query
 * params, and `Authorization: Bearer …` values must NEVER land in the
 * audit DB — those are exactly the credentials we are auditing.
 *
 * The returned shape is `<scheme>://<host>[:port]<pathname>` plus a
 * marker (`?[redacted]`) when a query string was present, so an
 * operator can still see "this request had query parameters" without
 * the values themselves. URLs that fail to parse fall through to a
 * fixed sentinel so a malformed value cannot smuggle a token through.
 *
 * Every URL-typed field in `AuditEntry` (and any future addition) MUST
 * be routed through this helper before entering the audit log.
 */
export function sanitizeUrlForAudit(rawUrl: string): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return "";
  try {
    const parsed = new URL(rawUrl);
    // Drop credentials embedded in the userinfo portion.
    parsed.username = "";
    parsed.password = "";
    const hadQuery = parsed.search.length > 0;
    parsed.search = "";
    parsed.hash = "";
    const base = parsed.toString();
    return hadQuery ? `${base}?[redacted]` : base;
  } catch {
    // Non-URL form (CONNECT authority, opaque token, etc.) — return a
    // fixed sentinel rather than echoing back unknown content.
    return "[unparseable-url]";
  }
}

function sanitizeEntry(entry: AuditEntry): AuditEntry {
  if (typeof entry.url !== "string" || entry.url.length === 0) return entry;
  return { ...entry, url: sanitizeUrlForAudit(entry.url) };
}

function sanitizeAuditEvent(entry: CredentialAuditEvent): CredentialAuditEvent {
  return "url" in entry ? sanitizeEntry(entry) : entry;
}

export function createAuditService(auditLog: AuditLog): ServiceDefinition {
  return {
    name: "audit",
    description: "Audit log query access",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      query: {
        args: z.tuple([auditQuerySchema.optional()]),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "query": {
          const entries = await auditLog.query(args[0] as AuditQuery | undefined);
          // Defense-in-depth: sanitise on read even if the writer (e.g.
          // a stale egressProxy) recorded a raw URL. The append-time
          // sanitisation must be wired in `egressProxy.ts` (Agent 5's
          // territory) by routing URL fields through `sanitizeUrlForAudit`
          // before calling `auditLog.append`.
          return entries.map(sanitizeAuditEvent);
        }
        default:
          throw new Error(`Unknown audit method: ${method}`);
      }
    },
  };
}

export { AuditLog };
