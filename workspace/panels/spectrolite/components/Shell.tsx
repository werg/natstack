/**
 * Top-level layout.
 *
 *   No vault   → picker screen (channel dock + notifier still live so the
 *                resident scribe stays reachable)
 *   Desktop    → header / editor / publish bar / channel dock, with Files,
 *                Backlinks and Workspace slide-over panels
 *   Mobile     → compact header, full-bleed editor, publish bar, bottom action
 *                strip, slide-in sidebar + bottom sheets
 *
 * Pure view code — every mutation goes through the app controllers /
 * per-document DocControllers.
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Button, Flex, Heading, IconButton, Text } from "@radix-ui/themes";
import {
  DotsHorizontalIcon,
  HamburgerMenuIcon,
  Link2Icon,
  ListBulletIcon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import { useIsMobile, usePaletteCommands } from "@workspace/react";
import { useApp, useAppState } from "../app/context";
import { WikilinkContext } from "../mdx/components";
import { resolveWikilinkTarget } from "../mdx/wikilink";
import { EditorPane } from "./EditorPane";
import { PublishBar } from "./PublishBar";
import { SendToScribe } from "./SendToScribe";
import { ChannelDrawer } from "./ChannelDrawer";
import { AgentMessageNotifier } from "./AgentMessageNotifier";
import { AgentBadges } from "./AgentRoster";
import { VaultPicker } from "./VaultPicker";
import { FilesDrawer, BacklinksDrawer, SettingsDrawer } from "./drawers";
import { MobileSidebar } from "./mobile/MobileSidebar";
import { BacklinksPanel } from "./BacklinksPanel";
import { FileTree } from "./FileTree";
import { QuickOpenDialog } from "./QuickOpen";

function pathToTitle(relPath: string): string {
  const name = relPath.split("/").pop() ?? relPath;
  return name.replace(/\.mdx$/, "");
}

/** Just the vault's leaf name (e.g. `default`), not the full workspace path. */
function vaultName(repoRoot: string): string {
  return repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
}

function useActiveTitle(): string | null {
  return useAppState((s) => (s.activePath ? pathToTitle(s.activePath) : null));
}

export function Shell({ theme }: { theme: "light" | "dark" }) {
  const app = useApp();
  const repoRoot = useAppState((s) => s.repoRoot);
  const isMobile = useIsMobile();
  const [quickOpen, setQuickOpen] = useState(false);

  // Wikilink bridge for the rendered doc: [[Page]] resolves against the
  // live path index at click time (no stale closures), and unresolved
  // targets are created Obsidian-style.
  const wikilinkContext = useMemo(() => ({
    resolve: (target: string) => resolveWikilinkTarget(target, app.store.getState().paths),
    open: (path: string) => app.openFile(path),
    openOrCreate: async (target: string) => {
      const resolved = resolveWikilinkTarget(target, app.store.getState().paths);
      if (resolved) {
        app.openFile(resolved);
        return;
      }
      try {
        const created = await app.vault.createFile(target, `# ${target}\n\n`);
        app.openFile(created);
      } catch (err) {
        console.warn(`[Spectrolite] create failed for "${target}":`, err);
      }
    },
  }), [app]);

  useEffect(() => {
    if (repoRoot === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [repoRoot]);

  // Contribute editor actions to the app-level command palette (Cmd/Ctrl+K).
  usePaletteCommands(
    useMemo(
      () => [
        { id: "quickOpen", label: "Quick open file…", section: "Editor" },
        { id: "newNote", label: "New note", section: "Editor" },
      ],
      []
    ),
    (id) => {
      if (id === "quickOpen") setQuickOpen(true);
      else if (id === "newNote") {
        void (async () => {
          try {
            const created = await app.vault.createFile("Untitled", "# Untitled\n\n");
            app.openFile(created);
          } catch (err) {
            console.warn("[Spectrolite] new note failed:", err);
          }
        })();
      }
    }
  );

  if (repoRoot === null) {
    return <PickerScreen />;
  }

  return (
    <WikilinkContext.Provider value={wikilinkContext}>
      {isMobile
        ? <MobileWorkspace theme={theme} onQuickOpen={() => setQuickOpen(true)} />
        : <DesktopWorkspace theme={theme} onQuickOpen={() => setQuickOpen(true)} />}
      <QuickOpenDialog open={quickOpen} onOpenChange={setQuickOpen} />
    </WikilinkContext.Provider>
  );
}

function PickerScreen() {
  const app = useApp();
  const agentHandle = useAppState((s) => s.roster[0]?.handle ?? s.installedAgents[0]?.handle);
  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      <Flex align="center" justify="between" gap="3" px="3" py="2" className="spectrolite-header">
        <Brand />
        <AgentBadges />
      </Flex>
      <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <VaultPicker
          agentHandle={agentHandle}
          onSelect={(contextPath, options) => app.vault.selectVault(contextPath, options)}
        />
      </Box>
      <ChannelDrawer />
      <AgentMessageNotifier />
    </Flex>
  );
}

function Brand() {
  return (
    <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
      <span className="spectrolite-gem spectrolite-gem--small" aria-hidden>◆</span>
      <Heading size="3">Spectrolite</Heading>
    </Flex>
  );
}

function DesktopWorkspace({ theme, onQuickOpen }: { theme: "light" | "dark"; onQuickOpen: () => void }) {
  const app = useApp();
  const repoRoot = useAppState((s) => s.repoRoot)!;
  const activePath = useAppState((s) => s.activePath);
  const activeTitle = useActiveTitle();
  const [filesOpen, setFilesOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      <Flex align="center" justify="between" gap="3" px="3" py="2" className="spectrolite-header">
        <Flex align="center" gap="2" style={{ minWidth: 0, flex: 1 }}>
          <Brand />
          <Button
            size="1"
            variant="ghost"
            color="gray"
            onClick={() => void app.vault.switchVault()}
            title={`${repoRoot.replace(/^\//, "")} — switch vault`}
            data-testid="spectrolite-toolbar-switch-vault"
          >
            {vaultName(repoRoot)}
          </Button>
          {activeTitle ? (
            <Text size="1" color="gray" truncate title={activePath ?? activeTitle}>
              / {activeTitle}
            </Text>
          ) : null}
        </Flex>
        <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
          {activePath ? <SendToScribe /> : null}
          <AgentBadges />
          <IconButton
            size="2"
            variant="ghost"
            color="gray"
            aria-label="Search files (⌘P)"
            title="Search files (⌘P)"
            onClick={onQuickOpen}
            data-testid="spectrolite-quick-open-trigger"
          >
            <MagnifyingGlassIcon />
          </IconButton>
          <IconButton
            size="2"
            variant="ghost"
            color="gray"
            aria-label="Files"
            title="Files"
            onClick={() => setFilesOpen(true)}
            data-testid="spectrolite-files-trigger"
          >
            <ListBulletIcon />
          </IconButton>
          {activePath ? (
            <IconButton
              size="2"
              variant="ghost"
              color="gray"
              aria-label="Backlinks"
              title="Backlinks"
              onClick={() => setBacklinksOpen(true)}
              data-testid="spectrolite-backlinks-trigger"
            >
              <Link2Icon />
            </IconButton>
          ) : null}
          <IconButton
            size="2"
            variant="ghost"
            color="gray"
            aria-label="Workspace settings"
            title="Workspace settings"
            onClick={() => setSettingsOpen(true)}
            data-testid="spectrolite-workspace-settings"
          >
            <DotsHorizontalIcon />
          </IconButton>
        </Flex>
      </Flex>

      <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <EditorPane theme={theme} onOpenFiles={() => setFilesOpen(true)} />
      </Box>

      <PublishBar />
      <ChannelDrawer />
      <AgentMessageNotifier />

      <FilesDrawer open={filesOpen} onOpenChange={setFilesOpen} />
      <BacklinksDrawer open={backlinksOpen} onOpenChange={setBacklinksOpen} />
      <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Flex>
  );
}

function MobileWorkspace({ theme, onQuickOpen }: { theme: "light" | "dark"; onQuickOpen: () => void }) {
  const repoRoot = useAppState((s) => s.repoRoot)!;
  const activeTitle = useActiveTitle();
  const activePath = useAppState((s) => s.activePath);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);

  return (
    <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
      <Flex align="center" gap="2" px="2" py="2" className="spectrolite-header" style={{ minHeight: 48 }}>
        <IconButton
          size="3"
          variant="ghost"
          color="gray"
          aria-label="Open files"
          onClick={() => setSidebarOpen(true)}
        >
          <HamburgerMenuIcon />
        </IconButton>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="2" weight="medium" truncate as="div" title={activePath ?? undefined}>
            {activeTitle ?? "Spectrolite"}
          </Text>
          <Text size="1" color="gray" truncate as="div">{vaultName(repoRoot)}</Text>
        </Box>
        <IconButton
          size="3"
          variant="ghost"
          color="gray"
          aria-label="Quick open"
          onClick={onQuickOpen}
          data-testid="spectrolite-quick-open-trigger"
        >
          <MagnifyingGlassIcon />
        </IconButton>
        <IconButton
          size="3"
          variant="ghost"
          color="gray"
          aria-label="Workspace settings"
          onClick={() => setSettingsSheetOpen(true)}
        >
          <DotsHorizontalIcon />
        </IconButton>
      </Flex>

      <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <EditorPane theme={theme} mobile onOpenFiles={() => setSidebarOpen(true)} />
      </Box>

      {/* One compact action bar (Send + Publish), not a separate strip — every
          row below the editor costs scarce vertical space on a phone. */}
      <PublishBar
        mobile
        trailing={
          activePath ? (
            <span data-testid="spectrolite-mobile-actions">
              <SendToScribe size="2" compact />
            </span>
          ) : null
        }
      />
      <ChannelDrawer />
      <AgentMessageNotifier />

      <MobileSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)}>
        <Flex direction="column" style={{ height: "100%" }}>
          <Flex align="center" justify="between" px="2" py="2" style={{ borderBottom: "1px solid var(--gray-4)" }}>
            <Heading size="2">Files</Heading>
            <Button size="2" variant="ghost" color="gray" onClick={() => setSidebarOpen(false)} aria-label="Close files">
              Done
            </Button>
          </Flex>
          <Box style={{ flex: 1, minHeight: 0 }}>
            <FileTree onOpened={() => setSidebarOpen(false)} />
          </Box>
          <Box style={{ maxHeight: "32vh", borderTop: "1px solid var(--gray-4)", overflow: "hidden" }}>
            <BacklinksPanel onOpened={() => setSidebarOpen(false)} />
          </Box>
        </Flex>
      </MobileSidebar>

      <SettingsDrawer open={settingsSheetOpen} onOpenChange={setSettingsSheetOpen} />
    </Flex>
  );
}
