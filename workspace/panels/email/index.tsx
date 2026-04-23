import { requestConsent, type CredentialHandle } from "@workspace/runtime/worker/credentials";

export const manifest = {
  providers: ["google"],
  scopes: {
    google: ["gmail_readonly", "gmail_send"],
  },
  endpoints: {
    google: [
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/*", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", methods: ["POST"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/labels", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/profile", methods: ["GET"] },
    ],
  },
};

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  payload?: {
    headers?: { name: string; value: string }[];
    body?: { data?: string };
    parts?: { mimeType: string; body?: { data?: string } }[];
  };
}

interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

let google: CredentialHandle | undefined;

async function ensureAuth(): Promise<CredentialHandle> {
  if (!google) {
    google = await requestConsent("google", {
      scopes: ["gmail_readonly", "gmail_send"],
    });
  }
  return google;
}

export async function getProfile(): Promise<GmailProfile> {
  await ensureAuth();
  const res = await fetch(`${GMAIL_API}/profile`);
  if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
  return (await res.json()) as GmailProfile;
}

export async function listMessages(opts?: {
  maxResults?: number;
  labelIds?: string[];
  q?: string;
  pageToken?: string;
}): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
  await ensureAuth();
  const params = new URLSearchParams();
  if (opts?.maxResults) params.set("maxResults", String(opts.maxResults));
  if (opts?.labelIds) params.set("labelIds", opts.labelIds.join(","));
  if (opts?.q) params.set("q", opts.q);
  if (opts?.pageToken) params.set("pageToken", opts.pageToken);

  const res = await fetch(`${GMAIL_API}/messages?${params}`);
  if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
  const data = (await res.json()) as { messages?: { id: string; threadId: string }[]; nextPageToken?: string };

  if (!data.messages?.length) {
    return { messages: [], nextPageToken: data.nextPageToken };
  }

  const messages = await Promise.all(
    data.messages.map(async (m) => getMessage(m.id)),
  );

  return { messages, nextPageToken: data.nextPageToken };
}

export async function getMessage(messageId: string): Promise<GmailMessage> {
  await ensureAuth();
  const res = await fetch(`${GMAIL_API}/messages/${messageId}`);
  if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
  return (await res.json()) as GmailMessage;
}

export async function sendMessage(params: {
  to: string;
  subject: string;
  body: string;
}): Promise<GmailMessage> {
  await ensureAuth();
  const raw = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    params.body,
  ].join("\r\n");

  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
  return (await res.json()) as GmailMessage;
}

export async function listLabels(): Promise<{ id: string; name: string; type: string }[]> {
  await ensureAuth();
  const res = await fetch(`${GMAIL_API}/labels`);
  if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
  const data = (await res.json()) as { labels: { id: string; name: string; type: string }[] };
  return data.labels;
}
