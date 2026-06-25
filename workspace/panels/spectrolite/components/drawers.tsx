/**
 * Desktop slide-over panels: Files, Backlinks, and Workspace settings.
 *
 * Implemented as Radix Dialogs (focus trap, Escape-to-close, unmount on
 * close) restyled as edge-anchored sheets with a slide animation. Each
 * carries the stable testid + a Close button the e2e suite drives.
 */

import { useSyncExternalStore, type ReactNode } from "react";
import { Box, Button, Dialog, Flex, Heading, IconButton, Separator, Text } from "@radix-ui/themes";
import { ChevronRightIcon, Cross2Icon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";
import { FileTree } from "./FileTree";
import { BacklinksPanel } from "./BacklinksPanel";
import { AgentRoster } from "./AgentRoster";
import { getPublishPresentation } from "./publishPresentation";

function VisuallyHidden({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        position: "absolute",
        border: 0,
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        wordWrap: "normal",
      }}
    >
      {children}
    </span>
  );
}

export interface SidePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  title: string;
  testId: string;
  width?: string;
  children: ReactNode;
}

export function SidePanel({ open, onOpenChange, side, title, testId, width = "min(38vw, 380px)", children }: SidePanelProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        maxWidth="100vw"
        data-testid={testId}
        className={`spectrolite-side-panel spectrolite-side-panel--${side}`}
        style={{
          position: "fixed",
          top: 0,
          bottom: 0,
          [side]: 0,
          [side === "left" ? "right" : "left"]: "auto",
          width,
          minWidth: 300,
          maxWidth: "100vw",
          margin: 0,
          padding: 0,
          borderRadius: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <VisuallyHidden>
          <Dialog.Title>{title}</Dialog.Title>
        </VisuallyHidden>
        <Flex align="center" justify="between" px="3" py="2" className="spectrolite-side-panel-header">
          <Heading size="2" truncate>{title}</Heading>
          <Dialog.Close>
            <IconButton size="2" variant="ghost" color="gray" aria-label="Close">
              <Cross2Icon />
            </IconButton>
          </Dialog.Close>
        </Flex>
        <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {children}
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export function FilesDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <SidePanel open={open} onOpenChange={onOpenChange} side="left" title="Files" testId="spectrolite-files-drawer" width="min(38vw, 360px)">
      <Box style={{ flex: 1, minHeight: 0 }}>
        <FileTree onOpened={() => onOpenChange(false)} />
      </Box>
    </SidePanel>
  );
}

export function BacklinksDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const activeTitle = useAppState((s) => s.activePath);
  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      title={activeTitle ? `Backlinks: ${activeTitle}` : "Backlinks"}
      testId="spectrolite-backlinks-drawer"
      width="min(34vw, 400px)"
    >
      <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <BacklinksPanel onOpened={() => onOpenChange(false)} />
      </Box>
    </SidePanel>
  );
}

export function SettingsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const app = useApp();
  return (
    <SidePanel open={open} onOpenChange={onOpenChange} side="right" title="Workspace" testId="spectrolite-workspace-settings-drawer" width="min(36vw, 420px)">
      <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }} p="4">
        <WorkspaceSettingsContent
          onSwitchVault={() => {
            onOpenChange(false);
            void app.vault.switchVault();
          }}
        />
      </Box>
    </SidePanel>
  );
}

/** Shared between the desktop settings drawer and the mobile bottom sheet. */
export function WorkspaceSettingsContent({ onSwitchVault }: { onSwitchVault: () => void }) {
  const repoRoot = useAppState((s) => s.repoRoot);
  const rosterCount = useAppState((s) => s.roster.length);
  if (!repoRoot) return null;
  return (
    <Flex direction="column" gap="4">
      <Section title="Vault">
        <Button
          size="3"
          variant="soft"
          color="gray"
          onClick={onSwitchVault}
          style={{ justifyContent: "space-between", width: "100%", minHeight: 48 }}
          data-testid="spectrolite-settings-switch-vault"
        >
          <Flex direction="column" align="start" style={{ flex: 1, textAlign: "left" }}>
            <Text size="2" weight="medium">{repoRoot.replace(/^\//, "")}</Text>
            <Text size="1" color="gray">Switch to a different vault</Text>
          </Flex>
          <ChevronRightIcon />
        </Button>
      </Section>

      <Separator size="4" />

      <Section title="Publish">
        <PublishSummary />
      </Section>

      <Separator size="4" />

      <Section title={`Agents (${rosterCount})`}>
        <AgentRoster />
      </Section>
    </Flex>
  );
}

function PublishSummary() {
  const app = useApp();
  const snapshot = useSyncExternalStore(
    (cb) => app.publish.subscribe(cb),
    () => app.publish.getSnapshot(),
    () => app.publish.getSnapshot(),
  );
  const dirtyCount = useAppState((s) => s.dirtyPaths.length);
  const presentation = getPublishPresentation(snapshot, dirtyCount);
  return (
    <Flex align="center" gap="2" justify="between" data-testid="spectrolite-vcs-head">
      <Flex direction="column">
        <Text size="2" weight="medium">
          {presentation.statusLabel}
        </Text>
        <Text size="1" color="gray">Changes stay on this vault's head until you publish.</Text>
      </Flex>
      <Button
        size="2"
        variant={presentation.hasChanges ? "solid" : "soft"}
        color={presentation.hasChanges ? "iris" : "gray"}
        disabled={!presentation.hasChanges || snapshot.publishing || presentation.publishBlocked}
        onClick={() => void app.publish.publish()}
        data-testid="spectrolite-settings-publish"
      >
        {snapshot.publishing ? "Publishing…" : "Publish"}
      </Button>
    </Flex>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Flex direction="column" gap="2">
      <Heading size="1" color="gray" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
        {title}
      </Heading>
      <Box>{children}</Box>
    </Flex>
  );
}
