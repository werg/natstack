/**
 * Code Editor Panel
 *
 * A Monaco-based code editor for NatStack panel/worker development.
 * Features file tree, tabbed editing, and integrated type checking.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { GitClient } from "@natstack/git";
import { fs, fsReady, gitConfig } from "@workspace/runtime";
import { useBootstrap } from "@workspace/react";
import * as path from "path";

import { useFileTree } from "./hooks/useFileTree";
import { useTabManager } from "./hooks/useTabManager";
import { useDiagnostics } from "./hooks/useDiagnostics";
import { useEditorNavigation } from "./hooks/useEditorNavigation";

import { FileTree } from "./components/FileTree";
import { EditorTabBar } from "./components/EditorTabBar";
import { EditorPanel } from "./components/EditorPanel";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { UnsavedChangesDialog } from "./components/UnsavedChangesDialog";

/**
 * Default workspace path - uses NATSTACK_WORKSPACE env var or falls back to /workspace.
 */
function getWorkspacePath(): string {
  const envPath = process.env["NATSTACK_WORKSPACE"]?.trim();
  return envPath || "/workspace";
}

/** State for unsaved changes dialog */
interface CloseConfirmState {
  tabId: string;
  fileName: string;
}

interface WorkspaceRoot {
  name: string;
  path: string;
  source: "default" | "repoArg" | "manual";
}

function mergeWorkspaceRoots(
  current: WorkspaceRoot[],
  incoming: WorkspaceRoot[]
): WorkspaceRoot[] {
  const byPath = new Map<string, WorkspaceRoot>();
  for (const root of current) {
    byPath.set(root.path, root);
  }
  for (const root of incoming) {
    if (!byPath.has(root.path)) {
      byPath.set(root.path, root);
    }
  }
  return [...byPath.values()];
}

function inferRepoName(repoPath: string): string {
  const parts = repoPath.split("/").filter(Boolean);
  const base = parts[parts.length - 1] || "repo";
  const sanitized = base.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return sanitized || "repo";
}

/**
 * Get channel ID from URL query parameters.
 */
function getChannelId(): string | null {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("channel");
}

export default function CodeEditorPanel() {
  const defaultWorkspacePath = getWorkspacePath();
  const bootstrap = useBootstrap();
  const workspaceSelectionRef = useRef(false);

  // Get channel ID from URL for diagnostics sharing
  const [channelId] = useState(getChannelId);

  const [workspacePath, setWorkspacePath] = useState(defaultWorkspacePath);
  const [workspaceRoots, setWorkspaceRoots] = useState<WorkspaceRoot[]>(() =>
    defaultWorkspacePath
      ? [{ name: "workspace", path: defaultWorkspacePath, source: "default" }]
      : []
  );

  // File tree state
  const fileTree = useFileTree(workspacePath);

  // Tab management
  const tabs = useTabManager();

  // Diagnostics from type checker (with optional channel connection)
  const diagnostics = useDiagnostics(workspacePath, channelId);

  // Event-based editor navigation
  const navigation = useEditorNavigation();

  // Unsaved changes dialog state
  const [closeConfirm, setCloseConfirm] = useState<CloseConfirmState | null>(null);
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [repoPathInput, setRepoPathInput] = useState("");
  const [repoRefInput, setRepoRefInput] = useState("");
  const [repoNameInput, setRepoNameInput] = useState("");
  const [repoStatus, setRepoStatus] = useState<{
    message: string;
    tone: "gray" | "red" | "green";
  } | null>(null);
  const [isRepoLoading, setIsRepoLoading] = useState(false);

  useEffect(() => {
    const argPaths = bootstrap.result?.argPaths;
    if (!argPaths) return;

    const roots = Object.entries(argPaths).map(([name, repoPath]) => ({
      name,
      path: repoPath,
      source: "repoArg" as const,
    }));

    if (roots.length === 0) return;
    setWorkspaceRoots((prev) => mergeWorkspaceRoots(prev, roots));

    if (!workspaceSelectionRef.current) {
      setWorkspacePath(roots[0]!.path);
      workspaceSelectionRef.current = true;
    }
  }, [bootstrap.result]);

  const handleWorkspaceSelect = useCallback((value: string) => {
    setWorkspacePath(value);
    workspaceSelectionRef.current = true;
  }, []);

  const handleLoadRepo = useCallback(async () => {
    const repoPath = repoPathInput.trim();
    if (!repoPath) {
      setRepoStatus({ message: "Repo path is required", tone: "red" });
      return;
    }
    if (!gitConfig) {
      setRepoStatus({ message: "Git config not available", tone: "red" });
      return;
    }

    const repoRef = repoRefInput.trim();
    const rawRepoName = repoNameInput.trim();
    const repoName = rawRepoName ? inferRepoName(rawRepoName) : inferRepoName(repoPath);
    if (!repoName) {
      setRepoStatus({ message: "Repo name is required", tone: "red" });
      return;
    }

    const targetPath = `/args/${repoName}`;
    setIsRepoLoading(true);
    setRepoStatus({ message: `Loading ${repoPath}...`, tone: "gray" });

    try {
      await fsReady;
      const git = new GitClient(fs, {
        serverUrl: gitConfig.serverUrl,
        token: gitConfig.token,
      });

      const exists = await git.isRepo(targetPath);
      if (exists) {
        if (repoRef) {
          await git.fetch({ dir: targetPath, ref: repoRef });
          await git.checkout(targetPath, repoRef);
        } else {
          await git.pull({ dir: targetPath });
        }
      } else {
        await git.clone({
          url: repoPath,
          dir: targetPath,
          ref: repoRef || undefined,
        });
      }

      setWorkspaceRoots((prev) =>
        mergeWorkspaceRoots(prev, [
          { name: repoName, path: targetPath, source: "manual" },
        ])
      );
      handleWorkspaceSelect(targetPath);
      setRepoStatus({
        message: `Loaded ${repoPath} into ${targetPath}`,
        tone: "green",
      });
      setRepoDialogOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRepoStatus({ message: `Failed to load repo: ${message}`, tone: "red" });
    } finally {
      setIsRepoLoading(false);
    }
  }, [
    repoPathInput,
    repoRefInput,
    repoNameInput,
    handleWorkspaceSelect,
    gitConfig,
  ]);

  const workspaceOptions = useMemo(
    () =>
      workspaceRoots.map((root) => ({
        value: root.path,
        label: `${root.name} - ${root.path}`,
      })),
    [workspaceRoots]
  );

  // Handle file selection from tree
  const handleFileSelect = useCallback(
    async (relativePath: string) => {
      const cleanPath = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
      const fullPath = path.join(workspacePath, cleanPath);
      try {
        const content = await fs.readFile(fullPath, "utf-8") as string;
        tabs.openTab(fullPath, content);
        // Expand path to the file in tree
        fileTree.expandPath(relativePath);
      } catch (err) {
        console.error("Failed to open file:", err);
      }
    },
    [workspacePath, tabs, fileTree]
  );

  // Handle editor content changes
  const handleEditorChange = useCallback(
    (content: string) => {
      if (tabs.activeTabId) {
        tabs.updateContent(tabs.activeTabId, content);
        // Notify diagnostics of file change
        if (tabs.activeFilePath) {
          diagnostics.updateFile(tabs.activeFilePath, content);
        }
      }
    },
    [tabs, diagnostics]
  );

  // Handle save
  const handleSave = useCallback(async () => {
    const tab = tabs.activeTab;
    if (!tab?.isModified) return;

    try {
      await fs.writeFile(tab.filePath, tab.content);
      tabs.markSaved(tab.id);
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }, [tabs]);

  // Save a specific tab by ID
  const saveTab = useCallback(
    async (tabId: string) => {
      const tab = tabs.tabs.find((t) => t.id === tabId);
      if (!tab?.isModified) return;

      try {
        await fs.writeFile(tab.filePath, tab.content);
        tabs.markSaved(tab.id);
      } catch (err) {
        console.error("Failed to save file:", err);
      }
    },
    [tabs]
  );

  // Handle cursor position changes
  const handleCursorChange = useCallback(
    (lineNumber: number, column: number) => {
      if (tabs.activeTabId) {
        tabs.updateCursorPosition(tabs.activeTabId, lineNumber, column);
      }
    },
    [tabs]
  );

  // Handle scroll changes
  const handleScrollChange = useCallback(
    (scrollTop: number) => {
      if (tabs.activeTabId) {
        tabs.updateScrollTop(tabs.activeTabId, scrollTop);
      }
    },
    [tabs]
  );

  // Handle tab close with unsaved changes check
  const handleTabClose = useCallback(
    (tabId: string) => {
      const tab = tabs.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      if (tab.isModified) {
        // Show confirmation dialog
        setCloseConfirm({ tabId, fileName: tab.fileName });
      } else {
        // Close immediately
        tabs.closeTab(tabId);
      }
    },
    [tabs]
  );

  // Handle unsaved changes dialog actions
  const handleCloseConfirmSave = useCallback(async () => {
    if (!closeConfirm) return;
    await saveTab(closeConfirm.tabId);
    tabs.closeTab(closeConfirm.tabId);
    setCloseConfirm(null);
  }, [closeConfirm, saveTab, tabs]);

  const handleCloseConfirmDiscard = useCallback(() => {
    if (!closeConfirm) return;
    tabs.closeTab(closeConfirm.tabId);
    setCloseConfirm(null);
  }, [closeConfirm, tabs]);

  const handleCloseConfirmCancel = useCallback(() => {
    setCloseConfirm(null);
  }, []);

  // Handle diagnostic navigation using event-based approach
  const handleDiagnosticNavigate = useCallback(
    (file: string, line: number, column: number) => {
      const existingTab = tabs.tabs.find((t) => t.filePath === file);

      if (!existingTab) {
        // Need to load the file first
        void (async () => {
          try {
            const content = await fs.readFile(file, "utf-8") as string;
            tabs.openTab(file, content);
            // Navigation will happen when editor subscribes
            navigation.navigateTo(line, column);
          } catch (err) {
            console.error("Failed to open file for navigation:", err);
          }
        })();
      } else {
        tabs.setActiveTab(existingTab.id);
        // Navigate using event system
        navigation.navigateTo(line, column);
      }
    },
    [tabs, navigation]
  );

  // Handle file tree refresh
  const handleRefresh = useCallback(() => {
    void fileTree.refresh();
  }, [fileTree]);

  return (
    <Flex style={{ height: "100vh", width: "100vw" }}>
      {/* Sidebar */}
      <Flex
        direction="column"
        style={{
          width: 270,
          minWidth: 180,
          maxWidth: 420,
          borderRight: "1px solid var(--gray-6)",
        }}
      >
        <Flex
          direction="column"
          gap="2"
          style={{
            padding: "8px 10px",
            borderBottom: "1px solid var(--gray-5)",
          }}
        >
          <Text size="1" weight="medium" color="gray">
            Workspace
          </Text>
          <Select.Root
            size="1"
            value={workspacePath || undefined}
            onValueChange={handleWorkspaceSelect}
          >
            <Select.Trigger
              placeholder="Select workspace"
              disabled={workspaceOptions.length === 0}
            />
            <Select.Content>
              {workspaceOptions.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  {option.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Button size="1" variant="soft" onClick={() => setRepoDialogOpen(true)}>
            Load Repo
          </Button>
          {bootstrap.loading && (
            <Text size="1" color="gray">
              Bootstrapping repos...
            </Text>
          )}
          {bootstrap.error && (
            <Text size="1" color="red">
              Bootstrap failed: {bootstrap.error}
            </Text>
          )}
          {repoStatus && (
            <Text size="1" color={repoStatus.tone}>
              {repoStatus.message}
            </Text>
          )}
          {channelId && (
            <Text size="1" color={diagnostics.channelConnected ? "green" : diagnostics.channelError ? "red" : "gray"}>
              {diagnostics.channelConnected
                ? "Channel connected"
                : diagnostics.channelError
                  ? `Channel error: ${diagnostics.channelError}`
                  : "Connecting to channel..."}
            </Text>
          )}
        </Flex>

        <FileTree
          root={fileTree.root}
          expandedPaths={fileTree.expandedPaths}
          isLoading={fileTree.isLoading}
          error={fileTree.error}
          onToggle={fileTree.toggleExpand}
          onSelect={handleFileSelect}
          onRefresh={handleRefresh}
          style={{
            flex: 1,
            minHeight: 0,
          }}
        />
      </Flex>

      {/* Main editor area */}
      <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
        {/* Tab bar */}
        <EditorTabBar
          tabs={tabs.tabs}
          activeId={tabs.activeTabId}
          onSelect={tabs.setActiveTab}
          onClose={handleTabClose}
        />

        {/* Editor */}
        <EditorPanel
          filePath={tabs.activeFilePath}
          content={tabs.activeTab?.content ?? null}
          cursorPosition={tabs.activeTab?.cursorPosition}
          scrollTop={tabs.activeTab?.scrollTop}
          diagnostics={diagnostics.forFile(tabs.activeFilePath)}
          onChange={handleEditorChange}
          onSave={handleSave}
          onCursorChange={handleCursorChange}
          onScrollChange={handleScrollChange}
          navigation={navigation}
          style={{ flex: 1 }}
        />

        {/* Diagnostics panel */}
        <DiagnosticsPanel
          diagnostics={diagnostics.all}
          errorCount={diagnostics.errorCount}
          warningCount={diagnostics.warningCount}
          onNavigate={handleDiagnosticNavigate}
          initError={diagnostics.initError}
          isInitializing={diagnostics.isInitializing}
        />
      </Flex>

      <Dialog.Root open={repoDialogOpen} onOpenChange={setRepoDialogOpen}>
        <Dialog.Content style={{ maxWidth: 480 }}>
          <Dialog.Title>Load Repository</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Clone a repository into this panel's context folder and set it as the
            active workspace.
          </Dialog.Description>
          <Flex direction="column" gap="3" mt="4">
            <Flex direction="column" gap="1">
              <Text size="1" weight="bold">
                Repo path
              </Text>
              <TextField.Root
                placeholder="e.g. panels/root or repos/my-app"
                value={repoPathInput}
                onChange={(e) => setRepoPathInput(e.target.value)}
              />
            </Flex>
            <Flex direction="column" gap="1">
              <Text size="1" weight="bold">
                Ref (optional)
              </Text>
              <TextField.Root
                placeholder="branch, tag, or commit"
                value={repoRefInput}
                onChange={(e) => setRepoRefInput(e.target.value)}
              />
            </Flex>
            <Flex direction="column" gap="1">
              <Text size="1" weight="bold">
                Local name (optional)
              </Text>
              <TextField.Root
                placeholder="defaults to repo name"
                value={repoNameInput}
                onChange={(e) => setRepoNameInput(e.target.value)}
              />
            </Flex>
            <Text size="1" color="gray">
              Repos are cloned under <Text weight="bold">/args/&lt;name&gt;</Text>.
            </Text>
          </Flex>
          <Flex gap="3" mt="4" justify="end">
            <Button variant="soft" color="gray" onClick={() => setRepoDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleLoadRepo} disabled={isRepoLoading}>
              {isRepoLoading ? "Loading..." : "Load Repo"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* Unsaved changes confirmation dialog */}
      <UnsavedChangesDialog
        open={closeConfirm !== null}
        fileName={closeConfirm?.fileName ?? ""}
        onSave={handleCloseConfirmSave}
        onDiscard={handleCloseConfirmDiscard}
        onCancel={handleCloseConfirmCancel}
      />
    </Flex>
  );
}
