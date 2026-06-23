/**
 * push service method schemas — mobile/remote shell push device registration
 * plus server-only delivery helpers.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const PushPlatformSchema = z.enum(["ios", "android", "web"]);

// Access descriptors shared across the push service's method groups. `callers`
// is left unset (the service-level policy `["shell", "app", "server"]` plus the
// per-method `server`-only policies remain the gate); these carry doc/safety
// metadata for the capability catalog.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const PushRegistrationSchema = z.object({
  token: z.string().describe("Platform push token (APNs/FCM/Web Push)."),
  platform: PushPlatformSchema.describe("Device platform the token belongs to."),
  clientId: z.string().describe("Stable client identifier the device registered under."),
  registeredAt: z.number().describe("Epoch milliseconds when the device was registered."),
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

export const PushSendOptionsSchema = z.object({
  clientId: z.string().describe("Client identifier of the registered device to deliver to."),
  title: z.string().describe("Notification title."),
  body: z.string().optional().describe("Notification body text."),
  category: z.string().optional().describe("Notification category for grouping/handling."),
  data: z
    .record(z.unknown())
    .optional()
    .describe("Arbitrary data payload delivered with the push."),
});
export type PushSendOptions = z.infer<typeof PushSendOptionsSchema>;

export const PushSendResultSchema = z.object({
  clientId: z.string().describe("Client identifier the push was addressed to."),
  platform: PushPlatformSchema.describe("Platform of the delivered registration."),
  sent: z.boolean().describe("Whether delivery was accepted (true even for log-only)."),
  logOnly: z.boolean().describe("True when Firebase was unavailable and the push was only logged."),
  error: z.string().optional().describe("Failure reason when delivery did not succeed."),
});
export type PushSendResult = z.infer<typeof PushSendResultSchema>;

export const PushRegisterRequestSchema = z.object({
  token: z.string().describe("Platform push token (APNs/FCM/Web Push)."),
  platform: PushPlatformSchema.describe("Device platform the token belongs to."),
  clientId: z.string().describe("Stable client identifier to register the device under."),
});
export type PushRegisterRequest = z.infer<typeof PushRegisterRequestSchema>;

export const pushMethods = defineServiceMethods({
  register: {
    description:
      "Register a device's push token for a client id, persisting it so it survives server restarts.",
    args: z.tuple([PushRegisterRequestSchema]),
    returns: z.object({ registered: z.boolean() }),
    access: WRITE_ACCESS,
    examples: [
      {
        args: [{ token: "abc123", platform: "ios", clientId: "client-1" }],
        returns: { registered: true },
      },
    ],
  },
  unregister: {
    description:
      "Remove the persisted push registration for a client id; returns whether one existed.",
    args: z.tuple([z.string()]),
    returns: z.object({ unregistered: z.boolean() }),
    access: { sensitivity: "destructive" },
    examples: [{ args: ["client-1"], returns: { unregistered: true } }],
  },
  send: {
    description:
      "Deliver a push notification to a registered device via Firebase, degrading to log-only when credentials are unavailable. Server-only.",
    args: z.tuple([PushSendOptionsSchema]),
    returns: PushSendResultSchema,
    policy: { allowed: ["server"] },
    access: WRITE_ACCESS,
  },
  listRegistrations: {
    description: "List all currently persisted push registrations. Server-only.",
    args: z.tuple([]),
    returns: z.array(PushRegistrationSchema),
    policy: { allowed: ["server"] },
    access: READ_ACCESS,
  },
});
