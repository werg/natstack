import { Badge, Box, Button, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import { ReloadIcon, LockClosedIcon } from "@radix-ui/react-icons";
import type {
  DetectedBrowser,
  DetectedProfile,
} from "@workspace/panel-browser";
import { useAsync, browserData, relativeTime } from "../useBrowserData";

export interface ProfileSelection {
  browser: DetectedBrowser;
  profile: DetectedProfile;
}

function profileKey(browserName: string, profilePath: string): string {
  return `${browserName}::${profilePath}`;
}

export function selectionKey(sel: ProfileSelection | null): string | null {
  return sel ? profileKey(sel.browser.name, sel.profile.path) : null;
}

export function BrowserProfileRail(props: {
  selected: ProfileSelection | null;
  onSelect: (sel: ProfileSelection) => void;
  now: number;
}) {
  const { state, reload } = useAsync<DetectedBrowser[]>(() => browserData.detectBrowsers(), []);

  return (
    <Box
      style={{
        width: 260,
        flexShrink: 0,
        borderRight: "1px solid var(--gray-a5)",
        height: "100%",
        overflowY: "auto",
      }}
      p="3"
    >
      <Flex justify="between" align="center" mb="2">
        <Heading size="2">Browsers</Heading>
        <Button size="1" variant="ghost" onClick={reload} aria-label="Re-detect browsers">
          <ReloadIcon /> Detect
        </Button>
      </Flex>

      {state.status === "loading" && (
        <Flex align="center" gap="2" py="2">
          <Spinner size="1" />
          <Text size="1" color="gray">
            Scanning…
          </Text>
        </Flex>
      )}
      {state.status === "error" && (
        <Text size="1" color="red">
          {state.error}
        </Text>
      )}
      {state.status === "ready" && (state.data?.length ?? 0) === 0 && (
        <Text size="1" color="gray">
          No browsers detected on this machine.
        </Text>
      )}

      <Flex direction="column" gap="3">
        {state.data?.map((browser) => (
          <Box key={browser.name}>
            <Flex align="center" gap="2" mb="1">
              <Text size="2" weight="bold">
                {browser.displayName}
              </Text>
              {browser.version && (
                <Text size="1" color="gray">
                  {browser.version}
                </Text>
              )}
              {browser.tccBlocked && (
                <Badge color="amber" variant="soft" size="1">
                  <LockClosedIcon width="10" height="10" /> blocked
                </Badge>
              )}
            </Flex>
            <Flex direction="column" gap="1">
              {browser.profiles.length === 0 && (
                <Text size="1" color="gray">
                  No profiles
                </Text>
              )}
              {browser.profiles.map((profile) => {
                const key = profileKey(browser.name, profile.path);
                const isSelected = selectionKey(props.selected) === key;
                return (
                  <ProfileRow
                    key={key}
                    browser={browser}
                    profile={profile}
                    selected={isSelected}
                    onSelect={() => props.onSelect({ browser, profile })}
                    now={props.now}
                  />
                );
              })}
            </Flex>
          </Box>
        ))}
      </Flex>
    </Box>
  );
}

function ProfileRow(props: {
  browser: DetectedBrowser;
  profile: DetectedProfile;
  selected: boolean;
  onSelect: () => void;
  now: number;
}) {
  const { browser, profile } = props;
  const { state } = useAsync(
    () => browserData.getProfileImportState({ browser: browser.name, profilePath: profile.path }),
    [browser.name, profile.path],
  );
  const lastRun = state.data?.lastRun;
  const lastFinished = lastRun ? Number(lastRun["finished_at"]) : null;

  return (
    <Box
      onClick={props.onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") props.onSelect();
      }}
      style={{
        cursor: "pointer",
        borderRadius: "var(--radius-2)",
        padding: "6px 8px",
        background: props.selected ? "var(--accent-a4)" : "transparent",
        border: props.selected ? "1px solid var(--accent-a7)" : "1px solid transparent",
      }}
    >
      <Flex align="center" gap="2">
        <Text size="1" weight={props.selected ? "bold" : "regular"} style={{ flex: 1 }} truncate>
          {profile.displayName}
        </Text>
        {profile.isDefault && (
          <Badge size="1" color="blue" variant="soft">
            default
          </Badge>
        )}
      </Flex>
      <Text size="1" color="gray">
        {browser.tccBlocked
          ? "needs disk access"
          : lastFinished
            ? `imported ${relativeTime(lastFinished, props.now)}`
            : "never imported"}
      </Text>
    </Box>
  );
}
