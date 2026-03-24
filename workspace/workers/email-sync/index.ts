/**
 * Email Sync Worker — background Gmail polling via Durable Object.
 *
 * Demonstrates the worker + PubSub pattern for real-time panel updates.
 * The EmailSyncWorker DO polls the Gmail API on a timer and publishes
 * new messages to a PubSub channel that the email panel subscribes to.
 */

export { EmailSyncWorker } from "./email-sync-do.js";

export default {
  fetch(_req: Request) {
    return new Response("email-sync Durable Object service\n", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
