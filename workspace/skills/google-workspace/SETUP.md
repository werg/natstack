# Google Workspace Setup Workflow

Use a workflow UI. Do not dump a wall of Google Cloud instructions into chat.
The user needs a checklist with direct Google Console links and a choice to
open each link inside NatStack or in the system browser.

This setup is modeled on gogcli's Google quick start: create/select one Google
Cloud project, enable the Workspace bundle NatStack requests up front, configure
OAuth consent/branding, add test users if the app is still in Testing, create a
**Desktop app** OAuth client, save its client ID and client secret, then connect
the account. NatStack asks Google for broad durable Workspace access once, then
uses local credential bindings to stage Gmail, Calendar, Drive, Docs, Sheets,
Slides, People, and identity separately inside the app.

## Required Console Links

| Step                           | Link                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| Create project                 | `https://console.cloud.google.com/projectcreate`                         |
| Credentials overview           | `https://console.cloud.google.com/apis/credentials`                      |
| Enable Gmail API               | `https://console.cloud.google.com/apis/api/gmail.googleapis.com`         |
| Enable Google Calendar API     | `https://console.cloud.google.com/apis/api/calendar-json.googleapis.com` |
| Enable Google Drive API        | `https://console.cloud.google.com/apis/api/drive.googleapis.com`         |
| Enable Google Docs API         | `https://console.cloud.google.com/apis/api/docs.googleapis.com`          |
| Enable Google Sheets API       | `https://console.cloud.google.com/apis/api/sheets.googleapis.com`        |
| Enable Google Slides API       | `https://console.cloud.google.com/apis/api/slides.googleapis.com`        |
| Enable People API              | `https://console.cloud.google.com/apis/api/people.googleapis.com`        |
| OAuth branding                 | `https://console.cloud.google.com/auth/branding`                         |
| OAuth audience / publish state | `https://console.cloud.google.com/auth/audience`                         |
| OAuth clients                  | `https://console.cloud.google.com/auth/clients`                          |

Optional APIs when the user's task needs them:

| Service                 | Link                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| Admin SDK               | `https://console.cloud.google.com/apis/api/admin.googleapis.com`         |
| Apps Script             | `https://console.cloud.google.com/apis/api/script.googleapis.com`        |
| Cloud Identity / Groups | `https://console.cloud.google.com/apis/api/cloudidentity.googleapis.com` |
| Google Chat             | `https://console.cloud.google.com/apis/api/chat.googleapis.com`          |
| Google Forms            | `https://console.cloud.google.com/apis/api/forms.googleapis.com`         |
| Google Tasks            | `https://console.cloud.google.com/apis/api/tasks.googleapis.com`         |

## Agent Flow

1. Run `getGoogleOnboardingStatus()`.
2. If setup is missing, show the workflow UI below.
3. The user uses the UI's deep links to finish Google Cloud Console work.
4. The user creates a **Desktop app** OAuth client.
5. Run `configureGoogleOAuthClient()` so the trusted approval UI collects the
   Desktop app `client_id` and `client_secret`. Do not ask the user to paste
   secrets into chat.
6. Run `connectGoogle()` to launch the host-owned PKCE flow. The helper asks
   Google for offline access and tells NatStack to persist the returned refresh
   token.
7. Run `verifyGoogleCredential(credentialId)` or
   `verifyGoogleConnection(connectionId)`.

Never skip Production publishing. Google's Testing mode can produce refresh
tokens that expire after 7 days for user-data scopes.

## Workflow UI

Render this with `feedback_custom` when `getGoogleOnboardingStatus()` reports
missing setup. Keep the agent response around the UI short.

```tsx
import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Grid,
  Heading,
  Link,
  Separator,
  Text,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ExternalLinkIcon,
  GlobeIcon,
  OpenInNewWindowIcon,
} from "@radix-ui/react-icons";
import { openPanel, openExternal } from "@workspace/runtime";

const requiredSteps = [
  {
    id: "project",
    title: "Create or select one Google Cloud project",
    href: "https://console.cloud.google.com/projectcreate",
    note: "Keep the same project selected for every later step.",
  },
  {
    id: "gmail",
    title: "Enable Gmail API",
    href: "https://console.cloud.google.com/apis/api/gmail.googleapis.com",
    note: "Required for Gmail search, labels, drafts, send, and modify operations.",
  },
  {
    id: "calendar",
    title: "Enable Google Calendar API",
    href: "https://console.cloud.google.com/apis/api/calendar-json.googleapis.com",
    note: "Required for calendar read/write and availability workflows.",
  },
  {
    id: "drive",
    title: "Enable Google Drive API",
    href: "https://console.cloud.google.com/apis/api/drive.googleapis.com",
    note: "Required for Drive files and Docs/Sheets/Slides export flows.",
  },
  {
    id: "docs",
    title: "Enable Google Docs API",
    href: "https://console.cloud.google.com/apis/api/docs.googleapis.com",
    note: "Included in the broad Workspace grant so future Docs workflows do not require reconnecting Google.",
  },
  {
    id: "sheets",
    title: "Enable Google Sheets API",
    href: "https://console.cloud.google.com/apis/api/sheets.googleapis.com",
    note: "Included in the broad Workspace grant for spreadsheet workflows.",
  },
  {
    id: "slides",
    title: "Enable Google Slides API",
    href: "https://console.cloud.google.com/apis/api/slides.googleapis.com",
    note: "Included in the broad Workspace grant for presentation workflows.",
  },
  {
    id: "people",
    title: "Enable People API",
    href: "https://console.cloud.google.com/apis/api/people.googleapis.com",
    note: "Required for contact lookup and account identity checks.",
  },
  {
    id: "branding",
    title: "Configure OAuth branding",
    href: "https://console.cloud.google.com/auth/branding",
    note: "Set app name, support email, and developer contact.",
  },
  {
    id: "audience",
    title: "Publish OAuth app to Production",
    href: "https://console.cloud.google.com/auth/audience",
    note: "Testing mode can expire refresh tokens after 7 days.",
    important: true,
  },
  {
    id: "client",
    title: "Create a Desktop app OAuth client",
    href: "https://console.cloud.google.com/auth/clients",
    note: "Choose Application type: Desktop app. You will enter its client_id and client_secret in NatStack's trusted approval UI.",
  },
];

const optionalApis = [
  ["Admin SDK", "https://console.cloud.google.com/apis/api/admin.googleapis.com"],
  ["Apps Script", "https://console.cloud.google.com/apis/api/script.googleapis.com"],
  [
    "Cloud Identity / Groups",
    "https://console.cloud.google.com/apis/api/cloudidentity.googleapis.com",
  ],
  ["Google Chat", "https://console.cloud.google.com/apis/api/chat.googleapis.com"],
  ["Google Forms", "https://console.cloud.google.com/apis/api/forms.googleapis.com"],
  ["Google Tasks", "https://console.cloud.google.com/apis/api/tasks.googleapis.com"],
];

export default function GoogleWorkspaceSetup({ onSubmit, onCancel }) {
  const [done, setDone] = useState({});
  const completed = useMemo(() => requiredSteps.filter((step) => done[step.id]).length, [done]);
  const allDone = completed === requiredSteps.length;

  const openInside = async (href) => {
    await openPanel(href, { focus: true, name: "Google Cloud Console" });
  };

  const openOutside = async (href) => {
    await openExternal(href);
  };

  return (
    <Flex direction="column" gap="4" p="2">
      <Flex align="start" justify="between" gap="3" wrap="wrap">
        <Box>
          <Heading size="4">Google Workspace setup</Heading>
          <Text size="2" color="gray">
            Use one Google Cloud project for APIs, OAuth branding, and the Desktop app client.
          </Text>
        </Box>
        <Badge color={allDone ? "green" : "blue"} variant="soft">
          {completed}/{requiredSteps.length} done
        </Badge>
      </Flex>

      <Grid columns={{ initial: "1", md: "2" }} gap="3">
        {requiredSteps.map((step, index) => (
          <Box
            key={step.id}
            style={{
              border: "1px solid var(--gray-6)",
              borderRadius: 8,
              padding: 12,
              background: step.important ? "var(--amber-2)" : "var(--gray-1)",
            }}
          >
            <Flex direction="column" gap="3">
              <Flex align="start" gap="2">
                <Checkbox
                  checked={Boolean(done[step.id])}
                  onCheckedChange={(checked) =>
                    setDone((prev) => ({ ...prev, [step.id]: checked === true }))
                  }
                />
                <Box>
                  <Text size="2" weight="bold">
                    {index + 1}. {step.title}
                  </Text>
                  <Text as="p" size="1" color="gray" mt="1">
                    {step.note}
                  </Text>
                  <Link size="1" href={step.href} target="_blank">
                    {step.href}
                  </Link>
                </Box>
              </Flex>
              <Flex gap="2" wrap="wrap">
                <Button size="1" variant="soft" onClick={() => openInside(step.href)}>
                  <GlobeIcon /> Internal
                </Button>
                <Button size="1" variant="soft" onClick={() => openOutside(step.href)}>
                  <OpenInNewWindowIcon /> External
                </Button>
              </Flex>
            </Flex>
          </Box>
        ))}
      </Grid>

      <Separator size="4" />

      <Flex direction="column" gap="2">
        <Text size="2" weight="bold">
          Optional APIs
        </Text>
        <Flex gap="2" wrap="wrap">
          {optionalApis.map(([label, href]) => (
            <Button key={label} size="1" variant="soft" onClick={() => openInside(href)}>
              <ExternalLinkIcon /> {label}
            </Button>
          ))}
        </Flex>
      </Flex>

      <Flex justify="end" gap="2">
        <Button variant="soft" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            onSubmit({ completed: Object.keys(done).filter((id) => done[id]), allDone })
          }
        >
          <CheckCircledIcon /> I created the Desktop client
        </Button>
      </Flex>
    </Flex>
  );
}
```

## Link Behavior

- **Internal** opens a NatStack browser panel. Prefer this when the user may
  want the agent to inspect page state or keep the flow in the workspace.
- **External** opens the system browser through approval-gated `openExternal`.
  Prefer this when the user is already signed into Google in their normal
  browser or needs password-manager/passkey/device auth.
- OAuth authorize URLs should use `openExternal(authorizeUrl, {
expectedRedirectUri })` so the host validates the OAuth callback binding
  before opening the browser.

## Gmail Push Notifications (optional, Cloud Pub/Sub)

Without this, the Gmail agent polls via the history API (default 5 min).
With it, Gmail pushes new-mail notifications to the natstack server and syncs
arrive in seconds; polling drops to a 30-minute safety net.

Requirements: a GCP project, a Pub/Sub topic, and a publicly reachable
natstack server URL (`NATSTACK_PUBLIC_URL`).

1. Create the topic and grant Gmail publish rights:
   ```bash
   gcloud pubsub topics create gmail-push
   gcloud pubsub topics add-iam-policy-binding gmail-push \
     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
     --role=roles/pubsub.publisher
   ```
2. Create one generic NatStack webhook subscription for Google Cloud Pub/Sub
   deliveries. Run this from a trusted panel/shell eval and keep the token:

   ```ts
   import { webhooks } from "@workspace/runtime";

   const token = "<secret>";
   const subscription = await webhooks.createSubscription({
     label: "gmail-cloud-pubsub",
     target: {
       source: "workers/gmail-agent",
       className: "GmailAgentWorker",
       objectKey: "gmail-push-router",
       method: "onWebhookDelivery",
     },
     delivery: { mode: "direct" },
     payload: { type: "cloud-pubsub", decodeData: "json" },
     verifier: { type: "query-token", paramName: "token", token },
     replay: { key: { type: "json-pointer", pointer: "/message/messageId" }, ttlMs: 86400000 },
     response: { successStatus: 204, malformedPayload: "ack", dispatchError: "ack" },
   });

   subscription.publicUrl; // append ?token=<secret> for the Google push endpoint
   ```

3. Create a Google Pub/Sub push subscription pointing at that generic webhook
   URL:
   ```bash
   gcloud pubsub subscriptions create gmail-push-natstack \
     --topic gmail-push \
     --push-endpoint="<subscription.publicUrl>?token=<secret>"
   ```
4. Configure the Gmail agent with the topic when subscribing it to a channel:

   ```ts
   import { setupGmailAgent } from "@workspace-skills/gmail";

   await setupGmailAgent({
     channelId: chat.channelId,
     googlePubSubTopicName: "projects/<project>/topics/gmail-push",
   });
   ```

The Gmail agent calls `users.watch` automatically on subscribe and renews it
daily via its alarm (watches last ~7 days). The generic server ingress only
verifies and decodes the Cloud Pub/Sub envelope; Gmail-specific mailbox fanout
lives in the Gmail worker's `gmail-push-router` object. Without
`googlePubSubTopicName`, history-API polling remains the only sync driver.
