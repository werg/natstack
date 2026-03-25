/**
 * Notification client — shared between panels and workers.
 *
 * Allows callers to push notifications to the shell chrome area
 * (info toasts, errors, warnings, success confirmations).
 */

import type { RpcCaller } from "@natstack/rpc";

export interface NotificationClient {
  /** Show a notification. Returns the notification ID. */
  show(opts: {
    type: "info" | "success" | "warning" | "error";
    title: string;
    message?: string;
    ttl?: number;
    actions?: Array<{ id: string; label: string; variant?: "solid" | "soft" | "ghost" }>;
  }): Promise<string>;

  /** Dismiss a notification by ID. */
  dismiss(id: string): Promise<void>;
}

export function createNotificationClient(rpc: RpcCaller): NotificationClient {
  return {
    async show(opts) {
      return rpc.call<string>("main", "notification.show", opts);
    },
    async dismiss(id) {
      await rpc.call<void>("main", "notification.dismiss", id);
    },
  };
}
