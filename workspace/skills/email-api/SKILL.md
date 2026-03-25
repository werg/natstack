# Email & Calendar API

Use `@workspace/integrations` to search, read, send emails and check calendar events.

## Setup

The first time, call `gmail.ensureConnected()`. This triggers OAuth consent (a notification appears in the shell asking the user to approve) and opens a sign-in browser panel. After that, tokens auto-refresh.

```ts
import { gmail } from "@workspace/integrations";
await gmail.ensureConnected();
```

## Gmail

```ts
import { gmail } from "@workspace/integrations";

// Search (uses Gmail search syntax)
const messages = await gmail.search("from:alice subject:meeting");
const unread = await gmail.search("is:unread", 5);
const recent = await gmail.search("newer_than:1d");

// Read
const thread = await gmail.getThread(messages[0].threadId);
const message = await gmail.getMessage(messageId);

// Send
await gmail.send({
  to: ["alice@example.com"],
  subject: "Re: Meeting",
  body: "Sounds good, see you then!",
  threadId: thread.id,           // optional: reply in thread
  inReplyTo: "<message-id>",     // optional: proper threading
});

// Organize
await gmail.markAsRead(messageId);
await gmail.archive(messageId);
await gmail.modifyLabels(messageId, ["STARRED"], ["UNREAD"]);

// Account info
const { email } = await gmail.getProfile();
const labels = await gmail.listLabels();
```

## Calendar

```ts
import { calendar } from "@workspace/integrations";

// List upcoming events
const events = await calendar.listEvents();
const next20 = await calendar.listEvents({ maxResults: 20 });
const thisWeek = await calendar.listEvents({
  timeMin: "2024-03-25T00:00:00Z",
  timeMax: "2024-03-31T23:59:59Z",
});

// Get event details
const event = await calendar.getEvent(eventId);
```

## Data shapes

**GmailMessage**: `{ id, threadId, subject, from, to[], date, snippet, body, labels[], isUnread }`

**GmailThread**: `{ id, subject, messages[], snippet }`

**CalendarEvent**: `{ id, summary, description?, start, end, location?, attendees[], htmlLink? }`

## Search syntax

Gmail search queries: `from:`, `to:`, `subject:`, `is:unread`, `is:starred`, `has:attachment`, `newer_than:1d`, `older_than:1w`, `label:`, `in:inbox`, `in:sent`, `in:trash`. Combine with spaces (AND) or `OR`.
