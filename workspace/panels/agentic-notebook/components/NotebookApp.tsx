import { useEffect, useState, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Box, Flex, Text, Theme } from "@radix-ui/themes";
import { Provider as JotaiProvider } from "jotai";
import { GitClient } from "@natstack/git";
import * as fs from "fs/promises";
import { usePanel } from "@natstack/react";

import { useThemeAppearance } from "../hooks/useTheme";

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
import { useKernel } from "../hooks/useKernel";
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
import { useMessages } from "../hooks/useChannel";

interface NotebookAppProps {
  panelId: string;
}

/**
 * Root component for the agentic notebook.
 */
export function NotebookApp({ panelId }: NotebookAppProps) {
  const panel = usePanel();
  const { initializeKernel } = useKernel();
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
  const themeAppearance = useThemeAppearance();
  const messages = useMessages();
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
    let mounted = true;

    const init = async () => {
      try {
        console.log("[NotebookApp] Starting initialization...");
        setIsInitializing(true);

        // Initialize storage (fs + git) and kernel/agent wiring
        const fsImpl = fs as unknown as import("../storage/ChatStore").FileSystem;
        const gitConfig = await panel.git.getConfig();
        const git = new GitClient(fsImpl, {
          serverUrl: gitConfig.serverUrl,
          token: gitConfig.token,
        });

        // Initialize kernel with fs bindings
        console.log("[NotebookApp] Initializing kernel...");
        const kernel = await initializeKernel(fsImpl);
        if (!mounted) return;

        // Initialize storage (OPFS)
        console.log("[NotebookApp] Initializing storage...");
        await initialize(fsImpl, git);
        if (!mounted) return;
        setStorageInitialized(true);

        // Initialize agent with the kernel
        console.log("[NotebookApp] Initializing agent with kernel...");
        await initializeAgent({ kernel, fs: fsImpl });
        if (!mounted) return;

        // Create new chat with default participants
        console.log("[NotebookApp] Creating new chat...");
        createNewChat();

        // Mark storage as initialized for UI even if persistence backend isn't ready
        setStorageInitialized(true);

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
  }, [initializeKernel, initializeAgent, createNewChat]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onAbort: abort,
    onNewChat: createNewChat,
    onToggleSidebar: () => setSidebarOpen((open) => !open),
  });

  // Auto-persist chat history whenever messages change
  useEffect(() => {
    if (!isInitializing) {
      // Fire and forget; debounced by batching of message state updates
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

  if (isInitializing) {
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
          <Text size="2" color="gray">Loading notebook...</Text>
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

          {/* Chat area - wrapped in ErrorBoundary to catch rendering errors */}
          <ErrorBoundary componentName="ChatArea">
            <ChatArea />
          </ErrorBoundary>

          {/* Input area */}
          <ErrorBoundary componentName="InputArea">
            <InputArea />
          </ErrorBoundary>
        </Flex>
      </Flex>

      {/* Keyboard shortcuts overlay - press ? to open */}
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
