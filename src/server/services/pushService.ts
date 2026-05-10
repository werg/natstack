/**
 * Push Notification Service — manages push notification registrations
 * for mobile/remote shell clients and delivers approval pushes through FCM.
 *
 * Registrations are persisted to ~/.config/natstack/push-registrations.json
 * so they survive server restarts. Delivery gracefully degrades to log-only
 * when Firebase credentials or firebase-admin are unavailable.
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { getCentralDataPath } from "@natstack/env-paths";
import type { PushApprovalDataPayload } from "@natstack/shared/approvalContract";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { pushMetrics, type PushMetrics } from "./pushMetrics.js";

export interface PushRegistration {
  token: string;
  platform: "ios" | "android" | "web";
  clientId: string;
  registeredAt: number;
}

export interface PushSendOptions {
  clientId: string;
  title: string;
  body?: string;
  category?: string;
  data?: PushApprovalDataPayload | Record<string, unknown>;
}

export interface PushBroadcastOptions {
  title: string;
  body?: string;
  category?: string;
  data?: PushApprovalDataPayload | Record<string, unknown>;
}

export interface PushSendResult {
  clientId: string;
  platform: PushRegistration["platform"];
  sent: boolean;
  logOnly: boolean;
  error?: string;
}

export interface PushServiceInternal {
  send(opts: PushSendOptions): Promise<PushSendResult>;
  sendBatch(opts: PushBroadcastOptions): Promise<PushSendResult[]>;
  cancel(approvalId: string, cancelKey?: string): Promise<PushSendResult[]>;
  listRegistrations(): PushRegistration[];
  unregister(clientId: string): boolean;
}

export interface PushServiceResult {
  definition: ServiceDefinition;
  internal: PushServiceInternal;
}

interface FirebaseMessagingClient {
  send(message: unknown): Promise<string>;
}

type FirebaseAdminLoader = () => Promise<FirebaseMessagingClient | null>;

interface PushServiceDeps {
  registrationsPath?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  firebaseAdminLoader?: FirebaseAdminLoader;
  metrics?: PushMetrics;
}

/** File path for persisted push registrations */
function getRegistrationsPath(): string {
  const configDir = getCentralDataPath();
  return path.join(configDir, "push-registrations.json");
}

/** Load registrations from disk. Returns an empty map on any failure. */
function loadRegistrations(filePath = getRegistrationsPath()): Map<string, PushRegistration> {
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
function saveRegistrations(registrations: Map<string, PushRegistration>, filePath = getRegistrationsPath()): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const entries = [...registrations.entries()];
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
  } catch (error) {
    console.warn("[PushService] Failed to save registrations to disk:", error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readServiceAccount(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const inlineJson = env["NATSTACK_FIREBASE_SERVICE_ACCOUNT_JSON"] ?? env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (inlineJson) {
    return JSON.parse(inlineJson) as Record<string, unknown>;
  }

  const candidatePaths = [
    env["NATSTACK_FIREBASE_SERVICE_ACCOUNT_PATH"],
    env["GOOGLE_APPLICATION_CREDENTIALS"],
    path.join(process.cwd(), "firebase-service-account.json"),
  ].filter((value): value is string => !!value);

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
    }
  }

  return null;
}

function createDefaultFirebaseLoader(env: NodeJS.ProcessEnv): FirebaseAdminLoader {
  let initialized: Promise<FirebaseMessagingClient | null> | null = null;
  return async () => {
    initialized ??= (async () => {
      const serviceAccount = readServiceAccount(env);
      if (!serviceAccount) {
        console.warn("[PushService] Firebase service account missing; using log-only push delivery");
        return null;
      }

      try {
        const appModule = await import("firebase-admin/app");
        const messagingModule = await import("firebase-admin/messaging");
        const app =
          appModule.getApps()[0] ??
          appModule.initializeApp({
            credential: appModule.cert(serviceAccount),
          });
        const messaging = messagingModule.getMessaging(app);
        return { send: (message) => messaging.send(message as never) };
      } catch (error) {
        console.warn("[PushService] Failed to initialize firebase-admin; using log-only push delivery:", error);
        return null;
      }
    })();
    return initialized;
  };
}

function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

function buildFirebaseMessage(
  registration: PushRegistration,
  opts: PushBroadcastOptions,
): Record<string, unknown> {
  const category = opts.category ?? String(opts.data?.["category"] ?? "");
  const kind = String(opts.data?.["kind"] ?? "");
  const cancelKey = String(opts.data?.["cancelKey"] ?? opts.data?.["approvalId"] ?? "");
  const body = opts.body && opts.body.length > 140 ? `${opts.body.slice(0, 137)}...` : opts.body;
  const data = stringifyData({
    title: opts.title,
    body,
    category,
    ...opts.data,
  });

  if (registration.platform === "ios") {
    if (kind === "approval-cancel") {
      return {
        token: registration.token,
        data,
        apns: {
          headers: {
            "apns-push-type": "background",
            "apns-priority": "5",
          },
          payload: {
            aps: {
              "content-available": 1,
            },
          },
        },
      };
    }

    const message: Record<string, unknown> = {
      token: registration.token,
      data,
      apns: {
        headers: {
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        payload: {
          aps: {
            ...(category ? { category } : {}),
            ...(cancelKey ? { "thread-id": cancelKey } : {}),
          },
        },
      },
    };
    if (opts.title || body) {
      message["notification"] = {
        title: opts.title,
        body: body ?? "",
      };
    }
    return message;
  }

  return {
    token: registration.token,
    data,
    android: {
      priority: "high",
    },
  };
}

function isInvalidTokenError(error: unknown): boolean {
  const code =
    typeof error === "object" && error
      ? String(
          (error as { code?: unknown; errorInfo?: { code?: unknown } }).code ??
            (error as { errorInfo?: { code?: unknown } }).errorInfo?.code ??
            "",
        )
      : "";
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
}

export function createPushService(deps: PushServiceDeps = {}): PushServiceResult {
  const registrationsPath = deps.registrationsPath ?? getRegistrationsPath();
  const registrations = loadRegistrations(registrationsPath);
  const now = deps.now ?? (() => Date.now());
  const metrics = deps.metrics ?? pushMetrics;
  const loadFirebase = deps.firebaseAdminLoader ?? createDefaultFirebaseLoader(deps.env ?? process.env);

  if (registrations.size > 0) {
    console.log(`[PushService] Loaded ${registrations.size} persisted registration(s)`);
  }

  async function sendToRegistration(
    registration: PushRegistration,
    opts: PushBroadcastOptions,
  ): Promise<PushSendResult> {
    const category = opts.category ?? String(opts.data?.["category"] ?? "unknown");
    try {
      const client = await loadFirebase();
      if (!client) {
        console.log(`[PushService] Log-only push for ${registration.clientId}: ${opts.title}`);
        metrics.recordPushSend({ platform: registration.platform, category, outcome: "log-only" });
        return {
          clientId: registration.clientId,
          platform: registration.platform,
          sent: true,
          logOnly: true,
        };
      }

      await client.send(buildFirebaseMessage(registration, opts));
      metrics.recordPushSend({ platform: registration.platform, category, outcome: "sent" });
      return {
        clientId: registration.clientId,
        platform: registration.platform,
        sent: true,
        logOnly: false,
      };
    } catch (error) {
      if (isInvalidTokenError(error)) {
        registrations.delete(registration.clientId);
        saveRegistrations(registrations, registrationsPath);
      }
      metrics.recordPushSend({ platform: registration.platform, category, outcome: "failed" });
      throw error;
    }
  }

  const internal: PushServiceInternal = {
    async send(opts) {
      const registration = registrations.get(opts.clientId);
      if (!registration) {
        metrics.recordPushSend({
          platform: "unknown",
          category: opts.category ?? String(opts.data?.["category"] ?? "unknown"),
          outcome: "no-registration",
        });
        throw new Error(`No push registration found for client ${opts.clientId}`);
      }
      return sendToRegistration(registration, opts);
    },

    async sendBatch(opts) {
      const results: PushSendResult[] = [];
      for (const registration of registrations.values()) {
        try {
          results.push(await sendToRegistration(registration, opts));
        } catch (error) {
          console.warn(`[PushService] Push send failed for ${registration.clientId}:`, error);
          results.push({
            clientId: registration.clientId,
            platform: registration.platform,
            sent: false,
            logOnly: false,
            error: errorMessage(error),
          });
        }
      }
      return results;
    },

    async cancel(approvalId, cancelKey) {
      metrics.recordPushCancel();
      return internal.sendBatch({
        title: "",
        data: {
          kind: "approval-cancel",
          approvalId,
          cancelKey: cancelKey ?? approvalId,
        } satisfies PushApprovalDataPayload,
      });
    },

    listRegistrations() {
      return [...registrations.values()];
    },

    unregister(clientId) {
      const existed = registrations.delete(clientId);
      if (existed) {
        saveRegistrations(registrations, registrationsPath);
        console.log(`[PushService] Unregistered device for client ${clientId}`);
      }
      return existed;
    },
  };

  const definition: ServiceDefinition = {
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
            category: z.string().optional(),
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
            registeredAt: now(),
          };
          registrations.set(opts.clientId, registration);
          saveRegistrations(registrations, registrationsPath);
          console.log(`[PushService] Registered device for client ${opts.clientId} (${opts.platform})`);
          return { registered: true };
        }

        case "unregister": {
          const [clientId] = args as [string];
          return { unregistered: internal.unregister(clientId) };
        }

        case "send": {
          const [opts] = args as [PushSendOptions];
          return internal.send(opts);
        }

        case "listRegistrations": {
          return internal.listRegistrations();
        }

        default:
          throw new Error(`Unknown push method: ${method}`);
      }
    },
  };

  return { definition, internal };
}

export const __private__ = {
  buildFirebaseMessage,
};
