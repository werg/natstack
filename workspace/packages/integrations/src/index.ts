/**
 * @workspace/integrations — High-level API clients for agent eval use.
 *
 * These wrap OAuth + fetch so agents can call APIs without knowing
 * auth details, raw URLs, or response schemas.
 *
 * Usage:
 *   import { gmail, calendar } from "@workspace/integrations";
 *   const messages = await gmail.search("from:alice");
 *   await gmail.send({ to: ["bob@example.com"], subject: "Hi", body: "Hello!" });
 *   const events = await calendar.listEvents();
 */

export * as gmail from "./gmail.js";
export * as calendar from "./calendar.js";

// Re-export types for convenience
export type { GmailMessage, GmailThread, SendOptions } from "./gmail.js";
export type { CalendarEvent } from "./calendar.js";
