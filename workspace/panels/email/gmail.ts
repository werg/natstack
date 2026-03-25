/**
 * Gmail & Calendar re-exports for the email panel.
 *
 * The actual API logic lives in @workspace/integrations so agents
 * can use the same code from eval. This module re-exports everything
 * and adds the panel-specific GmailClient/CalendarClient classes that
 * wrap the module-level functions with OAuthTokenProvider compatibility.
 */

export {
  search,
  getMessage,
  getThread,
  send as sendMessage,
  getProfile,
  listLabels,
  markAsRead,
  archive,
  modifyLabels,
  ensureConnected,
} from "@workspace/integrations/gmail";

export type {
  GmailMessage,
  GmailThread,
  SendOptions as SendMessageRequest,
} from "@workspace/integrations/gmail";

export {
  listEvents,
  getEvent,
} from "@workspace/integrations/calendar";

export type {
  CalendarEvent,
} from "@workspace/integrations/calendar";

import * as gmailApi from "@workspace/integrations/gmail";
import * as calendarApi from "@workspace/integrations/calendar";
import type { OAuthTokenProvider } from "./oauth.js";

/**
 * Class-based wrapper for panel UI use (preserves existing API).
 * Delegates to the stateless integrations module.
 */
export class GmailClient {
  constructor(private _provider: OAuthTokenProvider) {}

  search(query: string, maxResults?: number) { return gmailApi.search(query, maxResults); }
  getMessage(id: string) { return gmailApi.getMessage(id); }
  getThread(id: string) { return gmailApi.getThread(id); }
  sendMessage(opts: gmailApi.SendOptions) { return gmailApi.send(opts); }
  getProfile() { return gmailApi.getProfile(); }
  listLabels() { return gmailApi.listLabels(); }
  markAsRead(id: string) { return gmailApi.markAsRead(id); }
  archive(id: string) { return gmailApi.archive(id); }
}

export class CalendarClient {
  constructor(private _provider: OAuthTokenProvider) {}

  listEvents(opts?: Parameters<typeof calendarApi.listEvents>[0]) { return calendarApi.listEvents(opts); }
  getEvent(id: string, calendarId?: string) { return calendarApi.getEvent(id, calendarId); }
}

export class GmailApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GmailApiError";
  }
}
