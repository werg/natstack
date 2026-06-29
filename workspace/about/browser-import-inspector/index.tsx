/**
 * Browser Migration & State — a first-party operational dashboard for migrating
 * browser data into NatStack, safely re-running imports, inspecting the imported
 * store, opening current source-browser tabs as panels, and debugging the
 * address bar.
 *
 * Layout: a left rail of detected browsers/profiles + a three-tab work area
 * (Migrate / Inspect / Debug). Sensitive reads and all modifying effects route
 * through the approval-gated browser-data extension; the dense views render from
 * secret-free aggregates so the dashboard loads without prompts.
 */
import { useEffect, useState } from "react";
import { Box, Flex, Tabs, Text, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/tokens.css";
import { panel } from "@workspace/runtime";
import { usePanelTheme, useStateArgs } from "@workspace/react";
import { BrowserProfileRail, ProfileSelection } from "./components/BrowserProfileRail";
import { MigrateTab } from "./components/MigrateTab";
import { InspectTab } from "./components/InspectTab";
import { DebugTab } from "./components/DebugTab";

interface InspectorStateArgs {
  activeTab?: string;
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function BrowserImportInspector() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<InspectorStateArgs>();
  const now = useNow();
  const [selection, setSelection] = useState<ProfileSelection | null>(null);
  const [tab, setTab] = useState<string>(stateArgs.activeTab ?? "migrate");

  const changeTab = (value: string) => {
    setTab(value);
    panel.stateArgs.set({ ...panel.stateArgs.get(), activeTab: value });
  };

  return (
    <Theme appearance={theme} accentColor="iris" radius="medium">
    <Flex style={{ height: "100vh", width: "100%" }}>
      <BrowserProfileRail selected={selection} onSelect={setSelection} now={now} />
      <Box style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
        <Tabs.Root
          value={tab}
          onValueChange={changeTab}
          style={{ display: "flex", flexDirection: "column", height: "100%" }}
        >
          <Tabs.List>
            <Tabs.Trigger value="migrate">Migrate</Tabs.Trigger>
            <Tabs.Trigger value="inspect">Inspect</Tabs.Trigger>
            <Tabs.Trigger value="debug">Debug</Tabs.Trigger>
          </Tabs.List>
          <Box style={{ flex: 1, minHeight: 0 }}>
            <Tabs.Content value="migrate" style={{ height: "100%" }}>
              {selection ? (
                <MigrateTab selection={selection} now={now} />
              ) : (
                <EmptyState message="Select a browser profile on the left to plan an import." />
              )}
            </Tabs.Content>
            <Tabs.Content value="inspect" style={{ height: "100%" }}>
              <InspectTab now={now} />
            </Tabs.Content>
            <Tabs.Content value="debug" style={{ height: "100%" }}>
              <DebugTab selection={selection} />
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </Box>
    </Flex>
    </Theme>
  );
}

function EmptyState(props: { message: string }) {
  return (
    <Flex align="center" justify="center" style={{ height: "100%" }}>
      <Text size="2" color="gray">
        {props.message}
      </Text>
    </Flex>
  );
}
