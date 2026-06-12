/**
 * push service method schemas — mobile/remote shell push device registration
 * plus server-only delivery helpers.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const PushPlatformSchema = z.enum(["ios", "android", "web"]);

export const PushRegistrationSchema = z.object({
  token: z.string(),
  platform: PushPlatformSchema,
  clientId: z.string(),
  registeredAt: z.number(),
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

export const PushSendOptionsSchema = z.object({
  clientId: z.string(),
  title: z.string(),
  body: z.string().optional(),
  category: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});
export type PushSendOptions = z.infer<typeof PushSendOptionsSchema>;

export const PushSendResultSchema = z.object({
  clientId: z.string(),
  platform: PushPlatformSchema,
  sent: z.boolean(),
  logOnly: z.boolean(),
  error: z.string().optional(),
});
export type PushSendResult = z.infer<typeof PushSendResultSchema>;

export const PushRegisterRequestSchema = z.object({
  token: z.string(),
  platform: PushPlatformSchema,
  clientId: z.string(),
});
export type PushRegisterRequest = z.infer<typeof PushRegisterRequestSchema>;

export const pushMethods = defineServiceMethods({
  register: {
    args: z.tuple([PushRegisterRequestSchema]),
    returns: z.object({ registered: z.boolean() }),
  },
  unregister: {
    args: z.tuple([z.string()]),
    returns: z.object({ unregistered: z.boolean() }),
  },
  send: {
    args: z.tuple([PushSendOptionsSchema]),
    returns: PushSendResultSchema,
    policy: { allowed: ["server"] },
  },
  listRegistrations: {
    args: z.tuple([]),
    returns: z.array(PushRegistrationSchema),
    policy: { allowed: ["server"] },
  },
});
