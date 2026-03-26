/**
 * Google Calendar API client for agent eval and panel use.
 *
 * Usage from agent eval:
 *   import { calendar } from "@workspace/integrations";
 *   const events = await calendar.listEvents();
 *   const event = await calendar.getEvent(events[0].id);
 */

import { oauth } from "@workspace/runtime";

// ============================================================================
// Types
// ============================================================================

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
  htmlLink?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const PROVIDER = "google-mail"; // same Google OAuth connection

async function authedFetch<T>(url: string): Promise<T> {
  const token = await oauth.getToken(PROVIDER);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Calendar API error ${res.status}: ${body}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

// ============================================================================
// Calendar client
// ============================================================================

/**
 * List upcoming events.
 *
 * @example
 *   await calendar.listEvents()                          // next 10 events
 *   await calendar.listEvents({ maxResults: 20 })        // next 20
 *   await calendar.listEvents({ timeMin: "2024-03-01" }) // from specific date
 */
export async function listEvents(opts?: {
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  calendarId?: string;
}): Promise<CalendarEvent[]> {
  const calendarId = opts?.calendarId ?? "primary";
  const params = new URLSearchParams({
    timeMin: opts?.timeMin ?? new Date().toISOString(),
    maxResults: String(opts?.maxResults ?? 10),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (opts?.timeMax) params.set("timeMax", opts.timeMax);

  const data = await authedFetch<{ items?: GcalRawEvent[] }>(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );
  return (data.items ?? []).map(parseEvent);
}

/** Get a single event by ID. */
export async function getEvent(eventId: string, calendarId = "primary"): Promise<CalendarEvent> {
  const raw = await authedFetch<GcalRawEvent>(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
  );
  return parseEvent(raw);
}

// ============================================================================
// Internal types
// ============================================================================

interface GcalRawEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  attendees?: Array<{ email: string }>;
  htmlLink?: string;
}

function parseEvent(raw: GcalRawEvent): CalendarEvent {
  return {
    id: raw.id,
    summary: raw.summary ?? "(no title)",
    description: raw.description,
    start: raw.start?.dateTime ?? raw.start?.date ?? "",
    end: raw.end?.dateTime ?? raw.end?.date ?? "",
    location: raw.location,
    attendees: raw.attendees?.map(a => a.email) ?? [],
    htmlLink: raw.htmlLink,
  };
}
