/**
 * Wire schema for the server "panelRuntime" lease coordination service.
 */

import { z } from "zod";
import type {
  PanelRuntimeAcquireResult,
  PanelRuntimeLease,
  RuntimeLeaseSnapshot,
  RuntimeLeaseVersion,
} from "../panel/panelLease.js";
import { asPanelEntityId, asPanelSlotId } from "../panel/ids.js";
import type { SchemaCoversType } from "../schemaTypeGuard.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the read/write method groups. `callers` is
// left unset so the legacy `policy` (shell/app/server) stays the gate; these
// add doc/safety metadata.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const REGISTER_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const LEASE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const clientPlatformSchema = z.enum(["desktop", "headless", "mobile"]);
const panelSlotIdSchema = z.string().min(1).transform(asPanelSlotId);
const panelEntityIdSchema = z.string().min(1).transform(asPanelEntityId);

export const registerClientSchema = z.object({
  clientSessionId: z.string().min(1).describe("Stable id of the client session hosting panels."),
  hostConnectionId: z
    .string()
    .min(1)
    .optional()
    .describe("Connection id of the host transport; defaults to the client session id."),
  ownerCallerId: z
    .string()
    .min(1)
    .optional()
    .describe("Caller id that owns this client (set server-side from the request context)."),
  label: z.string().min(1).describe("Human-readable label for the lease holder."),
  platform: clientPlatformSchema.describe("Client platform: desktop, headless, or mobile."),
  supportsCdp: z
    .boolean()
    .optional()
    .describe("Whether this client can serve CDP automation; defaults true for non-mobile."),
  loadOnLeaseAssignment: z
    .boolean()
    .optional()
    .describe("Whether the client should eagerly load a panel when assigned a lease."),
});

export const leaseRequestSchema = z.object({
  slotId: z.string().min(1).describe("Panel slot the lease is being requested for."),
  clientSessionId: z.string().min(1).describe("Client session that will hold the lease."),
  connectionId: z.string().min(1).describe("Connection id tying the lease to a live transport."),
  hostConnectionId: z
    .string()
    .min(1)
    .optional()
    .describe("Host transport connection id; defaults to the client's registered host connection."),
});

export const runtimeLeaseVersionSchema = z
  .object({
    epoch: z.string().min(1),
    counter: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<RuntimeLeaseVersion>;

export const panelRuntimeLeaseSchema = z
  .object({
    slotId: panelSlotIdSchema,
    runtimeEntityId: panelEntityIdSchema,
    clientSessionId: z.string().min(1),
    hostConnectionId: z.string().min(1),
    connectionId: z.string().min(1),
    holderLabel: z.string().min(1),
    platform: clientPlatformSchema,
    supportsCdp: z.boolean(),
    loadOnLeaseAssignment: z.boolean(),
    acquiredAt: z.number(),
    expiresAt: z.number().optional(),
    // Set while an agent is actively automating the panel via CDP — pins it loaded (no unload/evict).
    keepLoaded: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<PanelRuntimeLease, z.ZodTypeDef, unknown>;

export const runtimeLeaseSnapshotSchema = z
  .object({
    version: runtimeLeaseVersionSchema,
    leases: z.array(panelRuntimeLeaseSchema),
  })
  .strict() satisfies z.ZodType<RuntimeLeaseSnapshot, z.ZodTypeDef, unknown>;

// ── Compile-time drift guards ────────────────────────────────────────────────────────────────────
// The `satisfies z.ZodType<T>` above only checks schema⊆type; these add the missing direction so a
// field added to a hand-written lease type WITHOUT adding it to its strict schema fails to compile
// HERE (naming the missing key) instead of rejecting that field at runtime parse. See SchemaCoversType.
const _leaseSchemaCoversType: SchemaCoversType<
  PanelRuntimeLease,
  z.infer<typeof panelRuntimeLeaseSchema>
> = true;
const _snapshotSchemaCoversType: SchemaCoversType<
  RuntimeLeaseSnapshot,
  z.infer<typeof runtimeLeaseSnapshotSchema>
> = true;
const _versionSchemaCoversType: SchemaCoversType<
  RuntimeLeaseVersion,
  z.infer<typeof runtimeLeaseVersionSchema>
> = true;
void _leaseSchemaCoversType;
void _snapshotSchemaCoversType;
void _versionSchemaCoversType;

export const panelRuntimeAcquireResultSchema = z.union([
  z
    .object({
      acquired: z.literal(true),
      lease: panelRuntimeLeaseSchema,
    })
    .strict(),
  z
    .object({
      acquired: z.literal(false),
      lease: panelRuntimeLeaseSchema,
    })
    .strict(),
]) satisfies z.ZodType<PanelRuntimeAcquireResult, z.ZodTypeDef, unknown>;

export const panelRuntimeMethods = defineServiceMethods({
  registerClient: {
    description:
      "Register (or refresh) a panel-hosting client session so it can be assigned runtime leases.",
    args: z.tuple([registerClientSchema]),
    returns: z.void(),
    access: REGISTER_ACCESS,
  },
  unregisterClient: {
    description:
      "Unregister a client session by id, releasing any leases it held and reassigning default CDP hosts as needed.",
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
    access: LEASE_ACCESS,
  },
  getSnapshot: {
    description: "Get the current lease snapshot (version + all active panel runtime leases).",
    args: z.tuple([]),
    returns: runtimeLeaseSnapshotSchema,
    access: READ_ACCESS,
  },
  acquire: {
    description:
      "Acquire the runtime lease for a panel entity. Succeeds for the current holder or an unleased entity; otherwise returns acquired:false with the existing lease.",
    args: z.tuple([z.string(), leaseRequestSchema]),
    returns: panelRuntimeAcquireResultSchema,
    access: LEASE_ACCESS,
  },
  takeOver: {
    description:
      "Forcibly take over a panel entity's runtime lease, revoking and closing any conflicting holder's connection.",
    args: z.tuple([z.string(), leaseRequestSchema]),
    returns: panelRuntimeAcquireResultSchema,
    access: LEASE_ACCESS,
  },
  release: {
    description:
      "Release the lease for a panel entity held by the given connection id. No-op unless the connection matches the current holder.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: LEASE_ACCESS,
  },
});
