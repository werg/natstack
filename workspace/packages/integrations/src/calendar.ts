const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

export const manifest = {
  providers: ["google"],
  scopes: {
    google: ["calendar_readonly", "calendar_events"],
  },
  endpoints: {
    google: [
      { url: "https://www.googleapis.com/calendar/v3/calendars/*", methods: ["GET"] },
      { url: "https://www.googleapis.com/calendar/v3/calendars/*/events", methods: ["GET", "POST"] },
      { url: "https://www.googleapis.com/calendar/v3/calendars/*/events/*", methods: ["GET", "PUT", "DELETE"] },
      { url: "https://www.googleapis.com/calendar/v3/users/me/calendarList", methods: ["GET"] },
    ],
  },
} as const;

export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  [key: string]: unknown;
}

export interface CalendarEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  [key: string]: unknown;
}

interface CalendarListResponse {
  items?: CalendarListEntry[];
  nextPageToken?: string;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface ListEventsOptions {
  timeMin?: string | Date;
  timeMax?: string | Date;
  syncToken?: string;
  maxResults?: number;
  showDeleted?: boolean;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
}

export interface ListEventsResult {
  items: CalendarEvent[];
  nextSyncToken?: string;
}

export interface StartPollingOptions {
  accessToken: string;
  calendarId: string;
  syncToken?: string;
  intervalMs?: number;
  timeMin?: string | Date;
  timeMax?: string | Date;
  maxResults?: number;
  showDeleted?: boolean;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
  onEventChange: (event: CalendarEvent) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

class GoogleCalendarApiError extends Error {
  status: number;

  statusText: string;

  body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`Google Calendar API ${status} ${statusText}: ${body}`);
    this.name = "GoogleCalendarApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function buildEventsQuery(options: ListEventsOptions = {}): string {
  if (options.syncToken && (options.timeMin || options.timeMax || options.orderBy)) {
    throw new Error("Google Calendar does not allow timeMin, timeMax, or orderBy when syncToken is set");
  }

  const params = new URLSearchParams();

  if (options.timeMin) {
    params.set("timeMin", toIsoString(options.timeMin));
  }

  if (options.timeMax) {
    params.set("timeMax", toIsoString(options.timeMax));
  }

  if (options.syncToken) {
    params.set("syncToken", options.syncToken);
  }

  if (typeof options.maxResults === "number") {
    params.set("maxResults", String(options.maxResults));
  }

  if (typeof options.showDeleted === "boolean") {
    params.set("showDeleted", String(options.showDeleted));
  }

  if (typeof options.singleEvents === "boolean") {
    params.set("singleEvents", String(options.singleEvents));
  }

  if (options.orderBy) {
    params.set("orderBy", options.orderBy);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

async function calendarFetch<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${GOOGLE_CALENDAR_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new GoogleCalendarApiError(response.status, response.statusText, await response.text());
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function listCalendars(accessToken: string): Promise<CalendarListEntry[]> {
  const calendars: CalendarListEntry[] = [];
  let pageToken: string | undefined;

  do {
    const query = pageToken ? `?${new URLSearchParams({ pageToken }).toString()}` : "";
    const page = await calendarFetch<CalendarListResponse>(
      accessToken,
      `/users/me/calendarList${query}`,
    );

    calendars.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return calendars;
}

export async function listEvents(
  accessToken: string,
  calendarId: string,
  options: ListEventsOptions = {},
): Promise<ListEventsResult> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken = options.syncToken;

  do {
    const params = new URLSearchParams(buildEventsQuery(options).slice(1));
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const query = params.toString();
    const page = await calendarFetch<EventsListResponse>(
      accessToken,
      `/calendars/${encodePathSegment(calendarId)}/events${query ? `?${query}` : ""}`,
    );

    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) {
      nextSyncToken = page.nextSyncToken;
    }
  } while (pageToken);

  return { items: events, nextSyncToken };
}

export async function getEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent> {
  return calendarFetch<CalendarEvent>(
    accessToken,
    `/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}`,
  );
}

export async function createEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEvent,
): Promise<CalendarEvent> {
  return calendarFetch<CalendarEvent>(
    accessToken,
    `/calendars/${encodePathSegment(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify(event),
    },
  );
}

export async function updateEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: CalendarEvent,
): Promise<CalendarEvent> {
  return calendarFetch<CalendarEvent>(
    accessToken,
    `/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}`,
    {
      method: "PUT",
      body: JSON.stringify(event),
    },
  );
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await calendarFetch<void>(
    accessToken,
    `/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}`,
    {
      method: "DELETE",
    },
  );
}

export function startPolling(options: StartPollingOptions): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  let active = true;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let syncToken = options.syncToken;

  const scheduleNextPoll = () => {
    if (!active) {
      return;
    }

    timeoutId = setTimeout(() => {
      void poll();
    }, intervalMs);
  };

  const poll = async () => {
    try {
      const result = await listEvents(options.accessToken, options.calendarId, syncToken
        ? {
            syncToken,
            maxResults: options.maxResults,
            showDeleted: true,
            singleEvents: options.singleEvents,
          }
        : {
            timeMin: options.timeMin,
            timeMax: options.timeMax,
            maxResults: options.maxResults,
            showDeleted: options.showDeleted,
            singleEvents: options.singleEvents,
            orderBy: options.orderBy,
          });

      for (const event of result.items) {
        await options.onEventChange(event);
      }

      if (result.nextSyncToken) {
        syncToken = result.nextSyncToken;
      }
    } catch (error) {
      if (error instanceof GoogleCalendarApiError && error.status === 410) {
        syncToken = undefined;
      } else if (options.onError) {
        await options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      scheduleNextPoll();
    }
  };

  void poll();

  return () => {
    active = false;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
}
