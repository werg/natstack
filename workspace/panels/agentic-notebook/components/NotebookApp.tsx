import { useEffect, useState, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Box, Flex, Text, Theme } from "@radix-ui/themes";
import { Provider as JotaiProvider } from "jotai";
import { GitClient } from "@natstack/git";
import * as fs from "fs/promises";
import { usePanel, usePanelTheme, useBootstrap } from "@natstack/react";
import { initialize as initializeEval } from "../eval";
import { useAgent } from "../hooks/useAgent";
import { useChatStorage } from "../hooks/useChatStorage";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { sidebarOpenAtom, isMobileAtom } from "../state/uiAtoms";

import { ParticipantBar } from "./ParticipantBar";
import { ChatArea } from "./ChatArea";
import { InputArea } from "./InputArea";
import { Sidebar } from "./Sidebar";
import { ErrorBoundary } from "./ErrorBoundary";
import { KeyboardShortcutsOverlay } from "./KeyboardShortcutsOverlay";
import { storageInitializedAtom } from "../state/storageAtoms";
import { useChannelMessages } from "../hooks/useChannel";

/**
 * Loading spinner component.
 */
function LoadingSpinner({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: "spin 1s linear infinite" }}
    >
      <style>
        {`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="var(--gray-6)"
        strokeWidth="3"
        fill="none"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="var(--accent-9)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

interface NotebookAppProps {
  panelId: string;
}

/**
 * Root component for the agentic notebook.
 */
export function NotebookApp({ panelId }: NotebookAppProps) {
  const panel = usePanel();
  const bootstrap = useBootstrap();
  const { initializeAgent, abort } = useAgent();
  const {
    initialize,
    createNewChat,
    loadChat,
    deleteChat,
    sync,
    saveCurrentChat,
  } = useChatStorage(panelId);

  const [sidebarOpen, setSidebarOpen] = useAtom(sidebarOpenAtom);
  const [isMobile, setIsMobile] = useAtom(isMobileAtom);
  const [isInitializing, setIsInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const themeAppearance = usePanelTheme();
  const { messages } = useChannelMessages();
  const setStorageInitialized = useSetAtom(storageInitializedAtom);

  // Detect mobile breakpoint
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 900;
      setIsMobile(mobile);
      if (mobile) {
        setSidebarOpen(false);
      }
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [setIsMobile, setSidebarOpen]);

  // Initialize app
  useEffect(() => {
    // Wait for bootstrap to complete before initializing
    if (bootstrap.loading) {
      return;
    }

    let mounted = true;

    const init = async () => {
      try {
        console.log("[NotebookApp] Starting initialization...");
        setIsInitializing(true);

        // Check for bootstrap errors
        if (bootstrap.error) {
          throw new Error(`Bootstrap failed: ${bootstrap.error}`);
        }

        // Get filesystem and git config
        const fsImpl = fs as unknown as import("../storage/ChatStore").FileSystem;
        const gitConfig = panel.gitConfig;
        if (!gitConfig) {
          throw new Error("Git configuration not available");
        }

        // Bootstrap is automatic - repos are cloned before panel loads
        const bootstrapResult = bootstrap.result;
        if (!bootstrapResult) {
          throw new Error(
            "Bootstrap result not available.\n\n" +
            "This panel requires repoArgs but bootstrap did not run.\n" +
            "Check that:\n" +
            "  1. package.json has: \"natstack\": { \"repoArgs\": [\"history\"] }\n" +
            "  2. Parent called createChild with: repoArgs: { history: \"path/to/repo\" }"
          );
        }
        console.log("[NotebookApp] Bootstrap complete:", bootstrapResult.actions);

        const git = new GitClient(fsImpl, {
          serverUrl: gitConfig.serverUrl,
          token: gitConfig.token,
        });

        // Pre-warm esbuild for code execution
        console.log("[NotebookApp] Initializing code execution runtime...");
        await initializeEval();
        if (!mounted) return;

        // Get history repo path from bootstrap result (cloned to /args/history)
        const historyRepoPath = bootstrapResult.argPaths.history;
        if (!historyRepoPath) {
          throw new Error("History repo arg not found - did parent provide repoArgs.history?");
        }

        // Initialize storage (OPFS)
        console.log("[NotebookApp] Initializing storage at", historyRepoPath);
        await initialize(fsImpl, git, historyRepoPath, gitConfig.serverUrl);
        if (!mounted) return;
        setStorageInitialized(true);

        // Initialize agent with file tools
        console.log("[NotebookApp] Initializing agent...");
        await initializeAgent({ fs: fsImpl });
        if (!mounted) return;

        // Create new chat
        console.log("[NotebookApp] Creating new chat...");
        createNewChat();

        console.log("[NotebookApp] Initialization complete");
        setIsInitializing(false);
      } catch (err) {
        console.error("[NotebookApp] Failed to initialize:", err);
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
          setIsInitializing(false);
        }
      }
    };

    init();

    return () => {
      mounted = false;
    };
  }, [bootstrap, initializeAgent, createNewChat, initialize, panel, setStorageInitialized]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onAbort: abort,
    onNewChat: createNewChat,
    onToggleSidebar: () => setSidebarOpen((open) => !open),
  });

  // Auto-persist chat history whenever messages change
  useEffect(() => {
    if (!isInitializing) {
      void (async () => {
        try {
          await saveCurrentChat();
        } catch (err) {
          console.warn("Failed to auto-save chat:", err);
        }
      })();
    }
  }, [messages, isInitializing, saveCurrentChat]);

  // Handle sidebar toggle
  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open);
  }, [setSidebarOpen]);

  // Handle share (sync to git)
  const handleShare = useCallback(async () => {
    await sync();
  }, [sync]);

  // Handle chat selection
  const handleSelectChat = useCallback(
    async (chatId: string) => {
      try {
        await loadChat(chatId);
        if (isMobile) {
          setSidebarOpen(false);
        }
      } catch (error) {
        console.error("Failed to load chat:", error);
      }
    },
    [loadChat, isMobile, setSidebarOpen]
  );

  // Handle chat deletion
  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      try {
        await deleteChat(chatId);
      } catch (error) {
        console.error("Failed to delete chat:", error);
      }
    },
    [deleteChat]
  );

  // Handle new chat with sidebar close on mobile
  const handleNewChat = useCallback(() => {
    createNewChat();
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [createNewChat, isMobile, setSidebarOpen]);

  if (bootstrap.loading || isInitializing) {
    const loadingMessage = bootstrap.loading
      ? "Cloning repositories..."
      : "Loading notebook...";
    return (
      <Theme accentColor="blue" grayColor="slate" radius="medium" appearance={themeAppearance}>
        <Flex
          align="center"
          justify="center"
          direction="column"
          gap="3"
          style={{ height: "100vh", background: "var(--gray-1)" }}
        >
          <LoadingSpinner size={32} />
          <Text size="2" color="gray">{loadingMessage}</Text>
        </Flex>
      </Theme>
    );
  }

  if (error) {
    return (
      <Theme accentColor="red" grayColor="slate" radius="medium" appearance={themeAppearance}>
        <Flex
          align="center"
          justify="center"
          style={{ height: "100vh", background: "var(--gray-1)" }}
        >
          <Box style={{ color: "var(--red-11)" }}>Error: {error}</Box>
        </Flex>
      </Theme>
    );
  }

  return (
    <Theme accentColor="blue" grayColor="slate" radius="medium" appearance={themeAppearance}>
      <Flex style={{ height: "100vh", background: "var(--gray-1)" }}>
        {/* Sidebar */}
        <Sidebar
          isOpen={sidebarOpen}
          isMobile={isMobile}
          onClose={() => setSidebarOpen(false)}
          onShare={handleShare}
          onNewChat={handleNewChat}
          onSelectChat={handleSelectChat}
          onDeleteChat={handleDeleteChat}
        />

        {/* Main content */}
        <Flex
          direction="column"
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
          }}
        >
          {/* Participant bar */}
          <ParticipantBar onToggleSidebar={handleToggleSidebar} />

          {/* Chat area */}
          <ErrorBoundary componentName="ChatArea">
            <ChatArea />
          </ErrorBoundary>

          {/* Input area */}
          <ErrorBoundary componentName="InputArea">
            <InputArea />
          </ErrorBoundary>
        </Flex>
      </Flex>

      {/* Keyboard shortcuts overlay */}
      <KeyboardShortcutsOverlay />
    </Theme>
  );
}

/**
 * Wrapped version with Jotai provider and top-level error boundary.
 */
export function NotebookAppWithProvider(props: NotebookAppProps) {
  return (
    <ErrorBoundary componentName="NotebookApp">
      <JotaiProvider>
        <NotebookApp {...props} />
      </JotaiProvider>
    </ErrorBoundary>
  );
}
