# GitHub Setup Workflow

Render this as an interactive checklist. Provide both internal and external
open buttons for GitHub settings links. Collect the final token only with
`requestGitHubTokenCredential()`, which opens the shell-owned credential input
prompt.

## Deep Links

- New fine-grained token: `https://github.com/settings/personal-access-tokens/new`
- Existing fine-grained tokens: `https://github.com/settings/personal-access-tokens`

## Steps

1. Open GitHub's fine-grained personal access token page.
2. Set a token name such as `NatStack`.
3. Choose an expiration that matches the user's tolerance for rotation.
4. Select repository access. Prefer selected repositories unless the user wants
   broad personal sandbox access.
5. Choose the token mode:
   - API only: GitHub API calls such as issues, pull requests, contents API, or
     Actions reads.
   - Git clone/pull/push: direct repository transport through
     `credentials.gitHttp()`.
   - API and Git: both of the above.
   Shared workspace remotes can be declared later with
   `git.setSharedRemote("panels/name", { name: "origin", url })`; that commits
   `meta/natstack.yml` and propagates the remote into workspace contexts.
6. Add permissions for the requested workflows:
   - Clone or pull: Metadata read, Contents read.
   - Push: Contents write.
   - Contents read: Metadata read, Contents read.
   - Contents write: Contents write.
   - Issues: Issues read/write.
   - Pull requests: Pull requests read/write.
   - Actions read: Actions read.
   - Workflow editing: Workflows write.
7. Generate the token.
8. Run `requestGitHubTokenCredential()` and let the user enter the token in the
   host approval UI.
9. Run `getGitHubOnboardingStatus({ verify: true })`.

## Example Eval

```ts
import {
  getGitHubOnboardingStatus,
  requestGitHubTokenCredential,
  verifyGitHubCredential,
} from "@workspace-skills/github";

const before = await getGitHubOnboardingStatus();
if (before.stage === "needs-token") {
  const stored = await requestGitHubTokenCredential({
    mode: "api",
    presets: ["contents-read", "issues", "pull-requests"],
  });
  const verification = await verifyGitHubCredential(stored.id);
  return { before, stored, verification };
}

return { before };
```

## UI Notes

Use the provider setup design language from `api-integrations`: compact
checklist rows, direct deep-link buttons, and a final `Save token` action that
calls the helper. Do not create a custom password field in panel state for the
PAT; the helper delegates that to the privileged shell prompt.

## Workflow UI

Render this with `feedback_custom` when `getGitHubOnboardingStatus()` reports
`needs-token`. Keep the surrounding assistant response short.

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
  GlobeIcon,
  OpenInNewWindowIcon,
} from "@radix-ui/react-icons";
import { createBrowserPanel, openExternal } from "@workspace/runtime";
import { requestGitHubTokenCredential } from "@workspace-skills/github";

const tokenUrl = "https://github.com/settings/personal-access-tokens/new";
const tokenListUrl = "https://github.com/settings/personal-access-tokens";

const steps = [
  {
    id: "open",
    title: "Open GitHub fine-grained tokens",
    href: tokenUrl,
    note: "Create a fine-grained personal access token for NatStack.",
  },
  {
    id: "repos",
    title: "Choose repository access",
    href: tokenUrl,
    note: "Use selected repositories unless you want broad sandbox access.",
  },
  {
    id: "mode",
    title: "Choose token mode",
    href: tokenUrl,
    note: "Use API only for issues and PRs, Git for clone/pull/push, or API and Git when this workspace needs both.",
  },
  {
    id: "contents",
    title: "Add Contents permissions",
    href: tokenUrl,
    note: "Use Read for clone/pull or contents reads. Add Write for push or repository contents writes.",
  },
  {
    id: "collaboration",
    title: "Add collaboration permissions",
    href: tokenUrl,
    note: "Add Issues and Pull requests read/write if this workspace should manage them.",
  },
  {
    id: "generate",
    title: "Generate the token",
    href: tokenListUrl,
    note: "Copy it once. GitHub will not show it again.",
    important: true,
  },
];

export default function GitHubSetup({ onSubmit, onCancel }) {
  const [done, setDone] = useState({});
  const [mode, setMode] = useState("api");
  const [saving, setSaving] = useState(false);
  const completed = useMemo(() => steps.filter((step) => done[step.id]).length, [done]);
  const allDone = completed === steps.length;

  const openInside = async (href) => {
    await createBrowserPanel(href, { focus: true, name: "GitHub settings" });
  };

  const openOutside = async (href) => {
    await openExternal(href);
  };

  const saveToken = async () => {
    setSaving(true);
    try {
      const stored = await requestGitHubTokenCredential({
        mode,
        presets:
          mode === "git"
            ? ["clone", "pull", "push"]
            : mode === "api-and-git"
              ? ["clone", "push", "issues", "pull-requests"]
              : ["contents-read", "issues", "pull-requests"],
      });
      onSubmit({ credentialId: stored.id, mode, completed: Object.keys(done).filter((id) => done[id]) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex direction="column" gap="4" p="2">
      <Flex align="start" justify="between" gap="3" wrap="wrap">
        <Box>
          <Heading size="4">GitHub setup</Heading>
          <Text size="2" color="gray">
            Generate a fine-grained token, then save it in NatStack's trusted credential prompt.
          </Text>
        </Box>
        <Badge color={allDone ? "green" : "blue"} variant="soft">
          {completed}/{steps.length} done
        </Badge>
      </Flex>

      <Grid columns={{ initial: "1", md: "2" }} gap="3">
        {steps.map((step, index) => (
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

      <Box style={{ border: "1px solid var(--gray-6)", borderRadius: 8, padding: 12 }}>
        <Flex direction="column" gap="2">
          <Text size="2" weight="bold">Token mode</Text>
          <Flex gap="2" wrap="wrap">
            {[
              ["api", "API only"],
              ["git", "Git clone/push"],
              ["api-and-git", "API and Git"],
            ].map(([value, label]) => (
              <Button
                key={value}
                size="1"
                variant={mode === value ? "solid" : "soft"}
                onClick={() => setMode(value)}
              >
                {label}
              </Button>
            ))}
          </Flex>
        </Flex>
      </Box>

      <Separator size="4" />

      <Flex justify="end" gap="2" wrap="wrap">
        <Button variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button disabled={!allDone || saving} onClick={saveToken}>
          <CheckCircledIcon /> Save token
        </Button>
      </Flex>
    </Flex>
  );
}
```
