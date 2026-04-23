import { listWebhookLeases } from "../../runtime/src/worker/credentials.js";

export async function hasRecentPushDelivery(
  providerId: string,
  eventType: string,
  connectionId: string,
  quietWindowMs: number,
): Promise<boolean> {
  const leases = await listWebhookLeases({ providerId, eventType, connectionId });
  const now = Date.now();
  return leases.some((lease) =>
    typeof lease.lastDeliveryAt === "number" && now - lease.lastDeliveryAt <= quietWindowMs
  );
}
