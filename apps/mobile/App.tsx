import React, { useEffect } from "react";
import { StatusBar } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { Provider as JotaiProvider, useAtomValue } from "jotai";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
import { BiometricLockScreen } from "./src/components/BiometricLockScreen";
import { useBiometricLock } from "./src/hooks/useBiometricLock";
import { setupOAuthHandler } from "./src/services/oauthHandler";
import { isAuthenticatedAtom } from "./src/state/authAtoms";
import { isDarkModeAtom } from "./src/state/themeAtoms";
import { shellClientAtom } from "./src/state/shellClientAtom";

function AppContent() {
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const { isLocked, unlock } = useBiometricLock(isAuthenticated);
  const isDark = useAtomValue(isDarkModeAtom);

  // Set up OAuth deep link handler when the shell client is available
  useEffect(() => {
    if (!shellClient) return;
    const cleanup = setupOAuthHandler(shellClient);
    return cleanup;
  }, [shellClient]);

  return (
    <>
    <StatusBar barStyle={isDark ? "light-content" : "dark-content"} translucent backgroundColor="transparent" />
    <ErrorBoundary label="App">
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>
      {isLocked && <BiometricLockScreen onUnlock={unlock} />}
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
