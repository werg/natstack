import React, { useEffect } from "react";
import { StatusBar } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { setupOAuthHandler } from "./src/services/oauthHandler";
import { setupNotificationCategories } from "./src/services/notificationCategories";
import { registerForPushNotifications } from "./src/services/pushNotifications";
import { isDarkModeAtom } from "./src/state/themeAtoms";
import { shellClientAtom } from "./src/state/shellClientAtom";
import { approvalDeepLinkAtom } from "./src/state/approvalDeepLinkAtom";
import { pushToastAtom } from "./src/state/toastAtoms";

function AppContent() {
  const shellClient = useAtomValue(shellClientAtom);
  const isDark = useAtomValue(isDarkModeAtom);
  const setApprovalDeepLink = useSetAtom(approvalDeepLinkAtom);
  const pushToast = useSetAtom(pushToastAtom);

  useEffect(() => {
    void setupNotificationCategories();
  }, []);

  // Set up OAuth deep link handler when the shell client is available
  useEffect(() => {
    if (!shellClient) return;
    const cleanup = setupOAuthHandler(shellClient);
    return cleanup;
  }, [shellClient]);

  useEffect(() => {
    if (!shellClient) return;
    let cleanup: (() => void) | null = null;
    let disposed = false;

    void registerForPushNotifications(shellClient, {
      onApprovalDeepLink: (approvalId) => setApprovalDeepLink(approvalId),
      onToast: (toast) => pushToast(toast),
    }).then((nextCleanup) => {
      if (disposed) {
        nextCleanup();
        return;
      }
      cleanup = nextCleanup;
    }).catch((error) => {
      console.warn("[App] Failed to initialize push notifications:", error);
      pushToast({
        durationMs: 10000,
        message: error instanceof Error ? error.message : String(error),
        title: "Push notifications unavailable",
        tone: "danger",
      });
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [pushToast, setApprovalDeepLink, shellClient]);

  return (
    <>
      <StatusBar
        barStyle={isDark ? "light-content" : "dark-content"}
        translucent
        backgroundColor="transparent"
      />
      <ErrorBoundary label="App">
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </ErrorBoundary>
    </>
  );
}

export default function App() {
  return (
    <JotaiProvider>
      <AppContent />
    </JotaiProvider>
  );
}
