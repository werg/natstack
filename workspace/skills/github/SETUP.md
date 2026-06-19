# GitHub Setup Workflow

Use this when the user wants guided help choosing repository access and
permissions. The default NatStack-friendly path is broad upstream access:
open a fine-grained PAT page prefilled for Broad, choose All repositories when
the user wants seamless future repository access, save the token with
`requestGitHubTokenCredential()`, and verify it. NatStack then stages access
internally with separate user API, repository API, release upload, and git
HTTPS bindings.

If rendering this as an interactive checklist, provide both internal and
external open buttons for GitHub settings links. Collect the final token only
with `requestGitHubTokenCredential()`, which opens the shell-owned credential
input prompt.

## Deep Links

- New fine-grained token: `https://github.com/settings/personal-access-tokens/new`
- Existing fine-grained tokens: `https://github.com/settings/personal-access-tokens`
- New classic token: `https://github.com/settings/tokens/new`
- Existing classic tokens: `https://github.com/settings/tokens`

## Token Choice

Always let the user choose the token style before opening GitHub:

- **Fine-grained PAT (recommended)**: use for broad-but-staged access. Select
  All repositories when the user wants future repository access without
  reconnecting, then grant the prefilled permission categories.
- **Classic PAT (broad)**: use when the user explicitly wants blanket/higher
  permissions. Select broad scopes such as `repo`.

## Steps

1. Open the chosen GitHub token page.
2. Set a token name such as `NatStack`.
3. Choose an expiration that matches the user's tolerance for rotation.
4. Select repository access. Prefer All repositories for the seamless broad
   workspace model; choose selected repositories only when the user explicitly
   wants upstream narrowing.
5. Add permissions for the requested workflow:
   - API-only default: Metadata read, Contents read, Issues read/write, Pull
     requests read/write.
   - Read Only: Metadata read, Contents read, Issues read, Pull requests read,
     Actions read, plus GitHub git HTTP for clone/pull.
   - Clone or pull only: Metadata read, Contents read.
   - Push: Metadata read, Contents write.
   - Actions reads: Metadata read, Actions read.
   - Workflow editing: Metadata read, Contents write, Workflows write.
   - Broad default: Contents, Issues, Pull requests, Actions, Workflows,
     Statuses, Deployments, and Discussions where GitHub's fine-grained PAT UI
     supports those categories.
6. Generate the token.
7. Run `requestGitHubTokenCredential()` and let the user enter the token in the
   host approval UI.
8. Run `getGitHubOnboardingStatus({ verify: true })`.
9. If a specific GitHub remote will be cloned or pulled, run
   `verifyGitHubGitRemoteAccess(remoteUrl, credentialId)`.

## Broad Access

If the user wants blanket or higher permissions, do not force them through the
least-privilege checklist.

- Fine-grained broad token: choose **All repositories**, then grant the
  repository permissions needed for the work, such as Contents read/write,
  Issues read/write, Pull requests read/write, Actions write, Workflows write,
  Statuses write, Deployments write, and Discussions write.
- Classic broad token: create a classic PAT and choose broad scopes such as
  `repo` when the user explicitly accepts broad private-repository access.

GitHub fine-grained PATs still do not cover every GitHub API surface. In
particular, Checks API write access is a GitHub App use case. Do not invent a
Checks PAT permission; use a GitHub App path if the user needs Checks.

When saving a classic PAT, call:

```ts
await requestGitHubTokenCredential({
  mode: "api-and-git",
  tokenKind: "classic",
});
```

## Advanced Modes

Choose the token mode only when the user needs something other than the
friendly access levels:

- API only: GitHub API calls such as issues, pull requests, contents API, or
  Actions reads.
- Git clone/pull/push: direct repository transport through
  `credentials.gitHttp()`.
- API and Git: both of the above.
  Shared workspace remotes can be declared later with
  `git.setSharedRemote("panels/name", { name: "origin", url, branch })`; that
  commits `meta/natstack.yml`, propagates the remote into workspace contexts,
  and lets missing configured repos auto-import on startup.

## Example Eval

```ts
import {
  getGitHubOnboardingStatus,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
  verifyGitHubGitRemoteAccess,
} from "@workspace-skills/github";

const before = await getGitHubOnboardingStatus();
if (before.stage === "needs-token") {
  const stored = await requestGitHubTokenCredential({
    accessLevel: "read-only",
  });
  const verification = await verifyGitHubCredential(stored.id);
  const gitVerification = await verifyGitHubGitRemoteAccess(
    "https://github.com/owner/repo.git",
    stored.id
  );
  return { before, stored, verification, gitVerification };
}

return { before };
```

## UI Notes

Use the provider setup design language from `api-integrations`: compact
checklist rows, direct deep-link buttons, and a final `Save token` action that
calls the helper. Do not create a custom password field in panel state for the
PAT; the helper delegates that to the privileged shell prompt.

For every GitHub settings link, offer both:

- **Internal** opens a NatStack browser panel with
  `openPanel(url, { focus: true })`. Prefer this when the user wants
  to keep setup inside the workspace or may want the agent to inspect page
  state.
- **External** opens the system browser through approval-gated
  `openExternal(url)`. Prefer this when the user is already signed into GitHub
  in their normal browser or needs password-manager/passkey/device auth.

If using the helper instead of custom buttons, call
`openGitHubTokenSettings({ tokenKind, accessLevel, browser: "internal" })` or
`openGitHubTokenSettings({ tokenKind, accessLevel, browser: "external" })`
based on the user's choice. Fine-grained token URLs are prefilled from the
selected access level where GitHub supports URL parameters.

## Workflow UI

Render this with `feedback_custom` when `getGitHubOnboardingStatus()` reports
`needs-token`. Keep the surrounding assistant response short.

```tsx
import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  RadioCards,
  Separator,
  Text,
} from "@radix-ui/themes";
import { CheckCircledIcon, GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import {
  buildGitHubTokenSettingsUrl,
  openGitHubTokenSettings,
  requestGitHubTokenCredential,
} from "@workspace-skills/github";

const accessLevels = [
  [
    "read-only",
    "Read Only",
    "Inspect repositories, issues, PRs, Actions, and clone/pull without changing code.",
  ],
  ["collaborate", "Collaborate", "Make normal code/content changes and work with issues and PRs."],
  ["code-workflows", "Code + Workflows", "Collaborate and edit GitHub Actions workflow files."],
  ["broad", "Broad", "High-trust access. Use with All repositories or a classic PAT."],
];

export default function GitHubSetup({ onSubmit, onCancel }) {
  const [tokenKind, setTokenKind] = useState("fine-grained");
  const [accessLevel, setAccessLevel] = useState("broad");
  const [saving, setSaving] = useState(false);
  const tokenUrl = buildGitHubTokenSettingsUrl({ tokenKind, accessLevel });

  const openTokenPage = async (browser) => {
    await openGitHubTokenSettings({ tokenKind, accessLevel, browser });
  };

  const saveToken = async () => {
    setSaving(true);
    try {
      const stored = await requestGitHubTokenCredential({ tokenKind, accessLevel });
      onSubmit({ credentialId: stored.id, tokenKind, accessLevel });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex direction="column" gap="4" p="2">
      <Flex align="start" justify="between" gap="3" wrap="wrap">
        <Box>
          <Heading size="4">GitHub access</Heading>
          <Text size="2" color="gray">
            Choose a token style and access level, then save the generated token in NatStack's
            trusted prompt.
          </Text>
        </Box>
        <Badge color={tokenKind === "classic" ? "amber" : "green"} variant="soft">
          {tokenKind === "classic" ? "Classic broad" : "Fine-grained"}
        </Badge>
      </Flex>

      <Box>
        <Text size="2" weight="bold">
          Token style
        </Text>
        <RadioCards.Root
          value={tokenKind}
          onValueChange={setTokenKind}
          columns={{ initial: "1", sm: "2" }}
          mt="2"
        >
          <RadioCards.Item value="fine-grained">
            <Flex direction="column" gap="1">
              <Text size="2" weight="bold">
                Fine-grained
              </Text>
              <Text size="1" color="gray">
                Recommended. Prefills GitHub's permission fields.
              </Text>
            </Flex>
          </RadioCards.Item>
          <RadioCards.Item value="classic">
            <Flex direction="column" gap="1">
              <Text size="2" weight="bold">
                Classic broad
              </Text>
              <Text size="1" color="gray">
                Legacy blanket scopes such as repo. Choose only when needed.
              </Text>
            </Flex>
          </RadioCards.Item>
        </RadioCards.Root>
      </Box>

      <Box>
        <Text size="2" weight="bold">
          Access level
        </Text>
        <Grid columns={{ initial: "1", sm: "2" }} gap="2" mt="2">
          {accessLevels.map(([value, label, description]) => (
            <Button
              key={value}
              variant={accessLevel === value ? "solid" : "soft"}
              onClick={() => setAccessLevel(value)}
              style={{ justifyContent: "flex-start", minHeight: 52 }}
            >
              <Flex direction="column" align="start" gap="1">
                <Text size="2" weight="bold">
                  {label}
                </Text>
                <Text size="1">{description}</Text>
              </Flex>
            </Button>
          ))}
        </Grid>
      </Box>

      <Box style={{ border: "1px solid var(--gray-6)", borderRadius: 8, padding: 12 }}>
        <Flex direction="column" gap="2">
          <Text size="2" weight="bold">
            GitHub page
          </Text>
          <Text size="1" color="gray" style={{ overflowWrap: "anywhere" }}>
            {tokenUrl}
          </Text>
          {tokenKind === "classic" ? (
            <Text size="1" color="amber">
              On GitHub, select the repo scope for broad private-repository access.
            </Text>
          ) : (
            <Text size="1" color="gray">
              GitHub will prefill the supported permission fields. Choose selected repositories or
              All repositories on GitHub.
            </Text>
          )}
          <Flex gap="2" wrap="wrap">
            <Button size="1" variant="soft" onClick={() => openTokenPage("internal")}>
              <GlobeIcon /> Internal
            </Button>
            <Button size="1" variant="soft" onClick={() => openTokenPage("external")}>
              <OpenInNewWindowIcon /> External
            </Button>
          </Flex>
        </Flex>
      </Box>

      <Separator size="4" />

      <Flex justify="end" gap="2" wrap="wrap">
        <Button variant="soft" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={saveToken}>
          <CheckCircledIcon /> Save token
        </Button>
      </Flex>
    </Flex>
  );
}
```
