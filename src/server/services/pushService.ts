/**
 * Push Notification Service — manages push notification registrations
 * for mobile/remote shell clients.
 *
 * Registrations are persisted to ~/.config/natstack/push-registrations.json
 * so they survive server restarts. Actual push delivery (APNs, FCM)
 * is a future integration point.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { getCentralDataPath } from "@natstack/env-paths";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";

export interface PushRegistration {
  token: string;
  platform: "ios" | "android" | "web";
  clientId: string;
  registeredAt: number;
}

/** File path for persisted push registrations */
function getRegistrationsPath(): string {
  const configDir = getCentralDataPath();
  return path.join(configDir, "push-registrations.json");
}

/** Load registrations from disk. Returns an empty map on any failure. */
function loadRegistrations(): Map<string, PushRegistration> {
  const filePath = getRegistrationsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return new Map();
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const entries = JSON.parse(raw) as Array<[string, PushRegistration]>;
    return new Map(entries);
  } catch (error) {
    console.warn("[PushService] Failed to load registrations from disk:", error);
    return new Map();
  }
}

/** Save registrations to disk. Logs a warning on failure. */
function saveRegistrations(registrations: Map<string, PushRegistration>): void {
  const filePath = getRegistrationsPath();
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const entries = [...registrations.entries()];
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch (error) {
    console.warn("[PushService] Failed to save registrations to disk:", error);
  }
}

export function createPushService(): ServiceDefinition {
  // Load persisted registrations from disk on startup
  const registrations = loadRegistrations();
  if (registrations.size > 0) {
    console.log(`[PushService] Loaded ${registrations.size} persisted registration(s)`);
  }

  return {
    name: "push",
    description: "Push notification device registration and delivery",
    policy: { allowed: ["shell", "server"] },
    methods: {
      register: {
        args: z.tuple([
          z.object({
            token: z.string(),
            platform: z.enum(["ios", "android", "web"]),
            clientId: z.string(),
          }),
        ]),
      },
      unregister: {
        args: z.tuple([z.string()]),
      },
      send: {
        args: z.tuple([
          z.object({
            clientId: z.string(),
            title: z.string(),
            body: z.string().optional(),
            data: z.record(z.unknown()).optional(),
          }),
        ]),
        policy: { allowed: ["server"] },
      },
      listRegistrations: {
        args: z.tuple([]),
        policy: { allowed: ["server"] },
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "register": {
          const [opts] = args as [{ token: string; platform: "ios" | "android" | "web"; clientId: string }];
          const registration: PushRegistration = {
            token: opts.token,
            platform: opts.platform,
            clientId: opts.clientId,
            registeredAt: Date.now(),
          };
          registrations.set(opts.clientId, registration);
          saveRegistrations(registrations);
          console.log(`[PushService] Registered device for client ${opts.clientId} (${opts.platform})`);
          return { registered: true };
        }

        case "unregister": {
          const [clientId] = args as [string];
          const existed = registrations.delete(clientId);
          if (existed) {
            saveRegistrations(registrations);
            console.log(`[PushService] Unregistered device for client ${clientId}`);
          }
          return { unregistered: existed };
        }

        case "send": {
          const [opts] = args as [{ clientId: string; title: string; body?: string; data?: Record<string, unknown> }];
          const registration = registrations.get(opts.clientId);
          if (!registration) {
            throw new Error(`No push registration found for client ${opts.clientId}`);
          }
          // MVP: log the push notification. Actual APNs/FCM delivery is a future integration.
          console.log(`[PushService] Push notification queued for ${opts.clientId}: ${opts.title}`);
          return {
            sent: true,
            platform: registration.platform,
            // In future: add delivery receipt ID from APNs/FCM
          };
        }

        case "listRegistrations": {
          return [...registrations.values()];
        }

        default:
          throw new Error(`Unknown push method: ${method}`);
      }
    },
  };
}
