# Google Workspace Setup Workflow

Use a workflow UI. Do not dump a wall of Google Cloud instructions into chat.
The user needs a checklist with direct Google Console links and a choice to
open each link inside NatStack or in the system browser.

This setup is modeled on gogcli's Google quick start: create/select one Google
Cloud project, enable only the APIs needed, configure OAuth consent/branding,
add test users if the app is still in Testing, create a **Desktop app** OAuth
client, save its client ID and client secret, then connect the account.

## Required Console Links

| Step | Link |
|------|------|
| Create project | `https://console.cloud.google.com/projectcreate` |
| Credentials overview | `https://console.cloud.google.com/apis/credentials` |
| Enable Gmail API | `https://console.cloud.google.com/apis/api/gmail.googleapis.com` |
| Enable Google Calendar API | `https://console.cloud.google.com/apis/api/calendar-json.googleapis.com` |
| Enable Google Drive API | `https://console.cloud.google.com/apis/api/drive.googleapis.com` |
| OAuth branding | `https://console.cloud.google.com/auth/branding` |
| OAuth audience / publish state | `https://console.cloud.google.com/auth/audience` |
| OAuth clients | `https://console.cloud.google.com/auth/clients` |

Optional APIs when the user's task needs them:

| Service | Link |
|---------|------|
| Admin SDK | `https://console.cloud.google.com/apis/api/admin.googleapis.com` |
| Apps Script | `https://console.cloud.google.com/apis/api/script.googleapis.com` |
| Cloud Identity / Groups | `https://console.cloud.google.com/apis/api/cloudidentity.googleapis.com` |
| Google Chat | `https://console.cloud.google.com/apis/api/chat.googleapis.com` |
| Google Docs | `https://console.cloud.google.com/apis/api/docs.googleapis.com` |
| Google Sheets | `https://console.cloud.google.com/apis/api/sheets.googleapis.com` |
| Google Slides | `https://console.cloud.google.com/apis/api/slides.googleapis.com` |
| Google Forms | `https://console.cloud.google.com/apis/api/forms.googleapis.com` |
| Google Tasks | `https://console.cloud.google.com/apis/api/tasks.googleapis.com` |
| People API | `https://console.cloud.google.com/apis/api/people.googleapis.com` |

## Agent Flow

1. Run `getGoogleOnboardingStatus()`.
2. If setup is missing, show the workflow UI below.
3. The user uses the UI's deep links to finish Google Cloud Console work.
4. The user creates a **Desktop app** OAuth client.
5. The user saves the Desktop app `client_id` and `client_secret` through the
   credential/provider setup path. Do not ask them to paste secrets into chat.
6. Run `beginGoogleCredentialCreation({ clientId, clientSecret, redirectUri })`, open the
   returned authorize URL with `openExternal(begin.authorizeUrl, {
   expectedRedirectUri: redirectUri })`, then complete the PKCE flow.
7. Run `verifyGoogleCredential(credentialId)`.

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
import { createBrowserPanel, openExternal } from "@workspace/runtime";

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
    note: "Choose Application type: Desktop app. Save its client_id and client_secret when connecting.",
  },
];

const optionalApis = [
  ["Admin SDK", "https://console.cloud.google.com/apis/api/admin.googleapis.com"],
  ["Apps Script", "https://console.cloud.google.com/apis/api/script.googleapis.com"],
  ["Cloud Identity / Groups", "https://console.cloud.google.com/apis/api/cloudidentity.googleapis.com"],
  ["Google Chat", "https://console.cloud.google.com/apis/api/chat.googleapis.com"],
  ["Google Docs", "https://console.cloud.google.com/apis/api/docs.googleapis.com"],
  ["Google Sheets", "https://console.cloud.google.com/apis/api/sheets.googleapis.com"],
  ["Google Slides", "https://console.cloud.google.com/apis/api/slides.googleapis.com"],
  ["Google Forms", "https://console.cloud.google.com/apis/api/forms.googleapis.com"],
  ["Google Tasks", "https://console.cloud.google.com/apis/api/tasks.googleapis.com"],
  ["People API", "https://console.cloud.google.com/apis/api/people.googleapis.com"],
];

export default function GoogleWorkspaceSetup({ onSubmit, onCancel }) {
  const [done, setDone] = useState({});
  const completed = useMemo(
    () => requiredSteps.filter((step) => done[step.id]).length,
    [done],
  );
  const allDone = completed === requiredSteps.length;

  const openInside = async (href) => {
    await createBrowserPanel(href, { focus: true, name: "Google Cloud Console" });
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
                  onCheckedChange={(checked) => setDone((prev) => ({ ...prev, [step.id]: checked === true }))}
                />
                <Box>
                  <Text size="2" weight="bold">{index + 1}. {step.title}</Text>
                  <Text as="p" size="1" color="gray" mt="1">{step.note}</Text>
                  <Link size="1" href={step.href} target="_blank">{step.href}</Link>
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
        <Text size="2" weight="bold">Optional APIs</Text>
        <Flex gap="2" wrap="wrap">
          {optionalApis.map(([label, href]) => (
            <Button key={label} size="1" variant="soft" onClick={() => openInside(href)}>
              <ExternalLinkIcon /> {label}
            </Button>
          ))}
        </Flex>
      </Flex>

      <Flex justify="end" gap="2">
        <Button variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ completed: Object.keys(done).filter((id) => done[id]), allDone })}>
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
