/**
 * Email panel RPC contract.
 *
 * Allows parent panels to interact with the email panel programmatically —
 * e.g. an agentic chat could call compose() to draft an email, or
 * search() to find messages matching a query.
 */

import { z, defineContract } from "@workspace/runtime";

export interface EmailPanelApi extends Record<string, (...args: any[]) => any> {
  /** Get the current connection status */
  getConnectionStatus(): Promise<{ connected: boolean; email?: string; provider?: string }>;

  /** Search messages across the mailbox */
  search(query: string, maxResults?: number): Promise<Array<{
    id: string;
    threadId: string;
    subject: string;
    from: string;
    date: string;
    snippet: string;
  }>>;

  /** Get full thread by ID */
  getThread(threadId: string): Promise<{
    id: string;
    subject: string;
    messages: Array<{
      id: string;
      from: string;
      to: string[];
      date: string;
      body: string;
    }>;
  }>;

  /** Open the compose view with optional pre-filled fields */
  compose(draft?: { to?: string; subject?: string; body?: string }): Promise<void>;

  /** Get upcoming calendar events */
  getCalendarEvents(timeMin?: string, timeMax?: string, maxResults?: number): Promise<Array<{
    id: string;
    summary: string;
    start: string;
    end: string;
    location?: string;
    attendees?: string[];
  }>>;
}

export const emailContract = defineContract({
  source: "panels/email",
  child: {
    methods: {} as EmailPanelApi,
    emits: {
      "connection-changed": z.object({
        connected: z.boolean(),
        email: z.string().optional(),
        provider: z.string().optional(),
      }),
      "thread-opened": z.object({
        threadId: z.string(),
        subject: z.string(),
      }),
      "message-sent": z.object({
        to: z.array(z.string()),
        subject: z.string(),
      }),
    },
  },
});
