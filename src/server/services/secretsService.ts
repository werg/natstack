/**
 * Secrets Service — manage API keys and secrets stored in
 * ~/.config/natstack/.secrets.yml.
 *
 * When a panel or worker calls setSecret, a consent notification is shown
 * so the user can approve or deny the write. Shell callers (the host UI)
 * bypass the consent prompt.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { NotificationServiceInternal } from "./notificationService.js";
import {
  loadSecrets,
  saveSecrets,
} from "@natstack/shared/workspace/loader";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";

/** Mask all but the last 4 characters of a secret value. */
function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

export function createSecretsService(deps: {
  notificationService: NotificationServiceInternal;
  panelRegistry?: PanelRegistry;
}): ServiceDefinition {
  const { notificationService, panelRegistry } = deps;

  function getCallerTitle(callerId: string, callerKind: string): string {
    if (callerKind === "panel" && panelRegistry) {
      const panels = panelRegistry.listPanels();
      const panel = panels.find(p => p.panelId === callerId);
      return panel?.title ?? callerId;
    }
    return callerId.replace(/^worker:/, "");
  }

  /**
   * Show a consent notification and block until the user approves or denies.
   * Throws if denied or timed out.
   */
  async function requestConsent(
    callerId: string,
    callerKind: string,
    action: "set" | "delete",
    key: string,
    maskedValue?: string,
  ): Promise<void> {
    const notifId = `secrets-consent-${randomUUID()}`;
    const callerTitle = getCallerTitle(callerId, callerKind);
    const verb = action === "set" ? "save" : "delete";

    const message = action === "set"
      ? `"${callerTitle}" wants to ${verb} secret "${key}" (${maskedValue})`
      : `"${callerTitle}" wants to ${verb} secret "${key}"`;

    notificationService.show({
      id: notifId,
      type: "consent",
      title: "Secret Update Requested",
      message,
      actions: [
        { id: "approve", label: "Allow", variant: "solid" },
        { id: "deny", label: "Deny", variant: "ghost" },
      ],
      sourcePanelId: callerKind === "panel" ? callerId : undefined,
    });

    const actionId = await notificationService.waitForAction(notifId, 120_000);
    if (actionId !== "approve") {
      throw new Error(`User denied ${verb} of secret "${key}"`);
    }
  }

  return {
    name: "secrets",
    description: "Manage API keys and secrets with user consent",
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      setSecret: {
        args: z.tuple([z.string(), z.string()]),
        policy: { allowed: ["shell", "panel", "worker"] as CallerKind[] },
      },
      deleteSecret: {
        args: z.tuple([z.string()]),
        policy: { allowed: ["shell", "panel", "worker"] as CallerKind[] },
      },
      listKeys: {
        args: z.tuple([]),
      },
    },
    handler: async (ctx, method, args) => {
      const callerId = ctx.callerId;
      const callerKind = ctx.callerKind as CallerKind;

      switch (method) {
        case "setSecret": {
          const [key, value] = args as [string, string];

          // Panels and workers require user consent; shell is trusted
          if (callerKind !== "shell") {
            await requestConsent(callerId, callerKind, "set", key, maskSecret(value));
          }

          const secrets = loadSecrets();
          secrets[key] = value;
          saveSecrets(secrets);
          return { success: true };
        }

        case "deleteSecret": {
          const [key] = args as [string];

          if (callerKind !== "shell") {
            await requestConsent(callerId, callerKind, "delete", key);
          }

          const secrets = loadSecrets();
          delete secrets[key];
          saveSecrets(secrets);
          return { success: true };
        }

        case "listKeys": {
          const secrets = loadSecrets();
          return Object.keys(secrets);
        }

        default:
          throw new Error(`Unknown secrets method: ${method}`);
      }
    },
  };
}
