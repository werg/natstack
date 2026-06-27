import React from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useAtomValue, useSetAtom } from "jotai";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
  getCredentials,
  resetToNativeBootstrap,
  StoredCredentialsNeedRepairError,
  type Credentials,
} from "../services/auth";
import { ShellClient } from "../services/shellClient";
import {
  serverUrlAtom,
  isAuthenticatedAtom,
  authLoadingAtom,
  authErrorAtom,
} from "../state/authAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";

function smokePhase(phase: string): void {
  console.log(`[NatStackMobileSmoke] phase=${phase}`);
}

type LoginScreenNavigationProp = StackNavigationProp<RootStackParamList, "Login">;

interface LoginScreenProps {
  navigation: LoginScreenNavigationProp;
}

function missingWorkspaceMessage(credentials: Credentials | null): string {
  if (!credentials) {
    return "No selected workspace is stored on this device. Scan a NatStack pairing QR code to choose a workspace.";
  }
  return "This device is paired with a server, but no workspace is selected. Scan a NatStack pairing QR code to choose a workspace.";
}

export function LoginScreen({ navigation }: LoginScreenProps) {
  const [retryNonce, setRetryNonce] = React.useState(0);
  const colors = useAtomValue(themeColorsAtom);

  const setServerUrlAtom = useSetAtom(serverUrlAtom);
  const setAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setAuthLoading = useSetAtom(authLoadingAtom);
  const setAuthError = useSetAtom(authErrorAtom);
  const setConnectionStatus = useSetAtom(connectionStatusAtom);
  const setShellClient = useSetAtom(shellClientAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const authLoading = useAtomValue(authLoadingAtom);
  const authError = useAtomValue(authErrorAtom);

  const handleResetToBootstrap = React.useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await resetToNativeBootstrap();
    } catch (error) {
      setAuthLoading(false);
      setAuthError(error instanceof Error ? error.message : "Could not return to pairing.");
    }
  }, [setAuthError, setAuthLoading]);

  React.useEffect(() => {
    let cancelled = false;
    let pendingClient: ShellClient | null = null;

    const finishConnectedClient = (client: ShellClient, credentials: Credentials) => {
      smokePhase("workspace-connected");
      client.startPeriodicSync();

      setShellClient(client);
      setServerUrlAtom(credentials.serverUrl);
      setAuthenticated(true);
      setAuthLoading(false);
      setAuthError(null);

      navigation.replace("Main");
    };

    const connect = async () => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        const credentials = await getCredentials();
        if (!credentials?.workspaceId) {
          throw new Error(missingWorkspaceMessage(credentials));
        }

        const client = new ShellClient({
          credentials,
          onStatusChange: (status) => {
            setConnectionStatus(status);
          },
          onTreeUpdated: (tree) => {
            setPanelTree(tree);
          },
        });
        pendingClient = client;

        await client.init();
        if (cancelled) {
          client.dispose();
          return;
        }
        finishConnectedClient(client, credentials);
        pendingClient = null;
      } catch (error) {
        pendingClient?.dispose();
        pendingClient = null;
        if (cancelled) return;
        setAuthLoading(false);
        const message =
          error instanceof StoredCredentialsNeedRepairError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Could not open the selected workspace.";
        setAuthError(message);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      pendingClient?.dispose();
    };
  }, [
    navigation,
    retryNonce,
    setAuthError,
    setAuthLoading,
    setAuthenticated,
    setConnectionStatus,
    setPanelTree,
    setServerUrlAtom,
    setShellClient,
  ]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>NatStack</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Opening the selected workspace
        </Text>

        {authLoading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.primary} size="large" />
            <Text style={[styles.message, { color: colors.textSecondary }]}>
              Connecting to your NatStack workspace...
            </Text>
          </View>
        ) : null}

        {authError ? (
          <View style={styles.errorBlock}>
            <Text style={[styles.errorText, { color: colors.danger }]} accessibilityRole="alert">
              {authError}
            </Text>
            <Text style={[styles.message, { color: colors.textSecondary }]}>
              Return to the native host bootstrap to pair or choose a workspace.
            </Text>
            <Pressable
              style={[styles.button, { backgroundColor: colors.primary }]}
              onPress={() => void handleResetToBootstrap()}
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>Open pairing</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, { borderColor: colors.border }]}
              onPress={() => setRetryNonce((value) => value + 1)}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Retry</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 32,
    textAlign: "center",
  },
  loadingBlock: {
    alignItems: "center",
    gap: 12,
  },
  errorBlock: {
    alignItems: "center",
    gap: 16,
    width: "100%",
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  errorText: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  button: {
    alignItems: "center",
    borderRadius: 8,
    height: 48,
    justifyContent: "center",
    marginTop: 8,
    width: "100%",
  },
  secondaryButton: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: "100%",
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
