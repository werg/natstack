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
import { defineServiceMethods } from "../typedServiceClient.js";

export const clientPlatformSchema = z.enum(["desktop", "headless", "mobile"]);
const panelSlotIdSchema = z.string().min(1).transform(asPanelSlotId);
const panelEntityIdSchema = z.string().min(1).transform(asPanelEntityId);

export const registerClientSchema = z.object({
  clientSessionId: z.string().min(1),
  hostConnectionId: z.string().min(1).optional(),
  label: z.string().min(1),
  platform: clientPlatformSchema,
  supportsCdp: z.boolean().optional(),
  loadOnLeaseAssignment: z.boolean().optional(),
});

export const leaseRequestSchema = z.object({
  slotId: z.string().min(1),
  clientSessionId: z.string().min(1),
  connectionId: z.string().min(1),
  hostConnectionId: z.string().min(1).optional(),
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
  })
  .strict() satisfies z.ZodType<PanelRuntimeLease, z.ZodTypeDef, unknown>;

export const runtimeLeaseSnapshotSchema = z
  .object({
    version: runtimeLeaseVersionSchema,
    leases: z.array(panelRuntimeLeaseSchema),
  })
  .strict() satisfies z.ZodType<RuntimeLeaseSnapshot, z.ZodTypeDef, unknown>;

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
  registerClient: { args: z.tuple([registerClientSchema]), returns: z.void() },
  unregisterClient: { args: z.tuple([z.string().min(1)]), returns: z.void() },
  getSnapshot: { args: z.tuple([]), returns: runtimeLeaseSnapshotSchema },
  acquire: {
    args: z.tuple([z.string(), leaseRequestSchema]),
    returns: panelRuntimeAcquireResultSchema,
  },
  takeOver: {
    args: z.tuple([z.string(), leaseRequestSchema]),
    returns: panelRuntimeAcquireResultSchema,
  },
  release: { args: z.tuple([z.string(), z.string()]), returns: z.void() },
});
