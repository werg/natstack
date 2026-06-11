// Must be the first import: react-native-gesture-handler requires its native
// side to be initialized before anything renders. The drawer navigator and the
// panel-tree swipe gestures depend on it.
import "react-native-gesture-handler";
import "./src/setupGlobals";
import React, { useEffect } from "react";
import { AppRegistry, Appearance, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { Provider as JotaiProvider, useAtomValue, useSetAtom } from "jotai";
import type { AppCapability } from "@natstack/shared/unitManifest";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { setApprovedAppCapabilities } from "./src/services/appCapabilities";
import { registerBackgroundHandlers } from "./src/services/backgroundHandlers";
import { setupOAuthHandler } from "./src/services/oauthHandler";
import { setupNotificationCategories } from "./src/services/notificationCategories";
import { registerForPushNotifications } from "./src/services/pushNotifications";
import { colorSchemeAtom, isDarkModeAtom } from "./src/state/themeAtoms";
import { shellClientAtom } from "./src/state/shellClientAtom";
import { approvalDeepLinkAtom } from "./src/state/approvalDeepLinkAtom";
import { pushToastAtom } from "./src/state/toastAtoms";

const APPROVED_APP_CAPABILITIES = [
  "notifications",
  "keychain",
  "clipboard",
  "open-external",
] satisfies readonly AppCapability[];

setApprovedAppCapabilities(APPROVED_APP_CAPABILITIES);
registerBackgroundHandlers();

function AppContent() {
  const shellClient = useAtomValue(shellClientAtom);
  const isDark = useAtomValue(isDarkModeAtom);
  const setColorScheme = useSetAtom(colorSchemeAtom);
  const setApprovalDeepLink = useSetAtom(approvalDeepLinkAtom);
  const pushToast = useSetAtom(pushToastAtom);

  // Track the system color scheme at the app root so the theme follows the OS
  // on every screen (login, settings, panels) — not only while MainScreen is
  // mounted. When a shell session exists, mirror the change to managed panels.
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme: nextScheme }) => {
      setColorScheme(nextScheme);
      if (shellClient) {
        void shellClient.panels.updateTheme(nextScheme === "light" ? "light" : "dark");
      }
    });
    return () => subscription.remove();
  }, [shellClient, setColorScheme]);

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

    void setupNotificationCategories().then(() => registerForPushNotifications(shellClient, {
      onApprovalDeepLink: (approvalId) => setApprovalDeepLink(approvalId),
      onToast: (toast) => pushToast(toast),
    })).then((nextCleanup) => {
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

function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <JotaiProvider>
          <AppContent />
        </JotaiProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

AppRegistry.registerComponent("NatStack", () => App);

export default App;
