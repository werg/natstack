import React from "react";
import {
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  Linking,
} from "react-native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useSetAtom, useAtomValue } from "jotai";
import type { RootStackParamList } from "../navigation/RootNavigator";
import {
  completePairing,
  getCredentials,
  StoredCredentialsNeedRepairError,
  type Credentials,
} from "../services/auth";
import { ensureNativeWorkspaceAppBundle } from "../services/appBootstrap";
import { getConnectionBootstrap } from "../services/connectionBootstrap";
import { ShellClient } from "../services/shellClient";
import {
  consumeConnectLinkReplay,
  isConnectLinkForStoredServer,
  markConnectLinkConsumed,
} from "../services/connectLinkReplayGuard";
import {
  serverUrlAtom,
  isAuthenticatedAtom,
  authLoadingAtom,
  authErrorAtom,
} from "../state/authAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { parseConnectDeepLink } from "../services/deepLinkConnect";

function smokePhase(phase: string): void {
  console.log(`[NatStackMobileSmoke] phase=${phase}`);
}

function confirmConnectDeepLink(serverUrl: string): Promise<boolean> {
  // Any installed app can fire a natstack://connect intent. Always confirm
  // before replacing creds, so a malicious link can't silently hijack the
  // session even when saved credentials are already present.
  return new Promise((resolve) => {
    Alert.alert(
      "Connect to server?",
      `A link wants to connect NatStack to:\n\n${serverUrl}\n\nOnly proceed if you trust this link.`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Connect", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

type LoginScreenNavigationProp = StackNavigationProp<RootStackParamList, "Login">;

interface LoginScreenProps {
  navigation: LoginScreenNavigationProp;
}

export function LoginScreen({ navigation }: LoginScreenProps) {
  const [serverUrl, setServerUrl] = React.useState("");
  const [pairingCode, setPairingCode] = React.useState("");
  const [bootstrapPending, setBootstrapPending] = React.useState(true);
  const [autoConnecting, setAutoConnecting] = React.useState(false);
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

  // Reusable connect logic shared by auto-connect and manual button
  const connectWithCredentials = async (
    credentials: Credentials,
    options?: { showAlert?: boolean }
  ): Promise<boolean> => {
    setAuthLoading(true);
    setAuthError(null);

    try {
      const client = new ShellClient({
        credentials,
        onStatusChange: (status) => {
          setConnectionStatus(status);
        },
        onTreeUpdated: (tree) => {
          setPanelTree(tree);
        },
      });

      await client.init();
      smokePhase("workspace-connected");
      client.startPeriodicSync();

      setShellClient(client);
      setServerUrlAtom(credentials.serverUrl);
      setAuthenticated(true);
      setAuthLoading(false);

      navigation.replace("Main");
      return true;
    } catch (error) {
      setAuthLoading(false);
      const message = error instanceof Error ? error.message : "Connection failed";
      setAuthError(message);
      if (options?.showAlert !== false) {
        Alert.alert("Connection Failed", message);
      }
      return false;
    }
  };

  // Keep a ref so the mount effect always calls the latest version
  const connectRef = React.useRef(connectWithCredentials);
  connectRef.current = connectWithCredentials;

  const pairAndConnect = async (
    targetUrl: string,
    code: string,
    options?: { showAlert?: boolean; connectLinkUrl?: string }
  ): Promise<boolean> => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const credentials = await completePairing(targetUrl, code);
      smokePhase("workspace-pairing-complete");
      if (options?.connectLinkUrl) {
        await markConnectLinkConsumed(options.connectLinkUrl);
      }
      if ((await ensureNativeWorkspaceAppBundle()).reloading) {
        smokePhase("workspace-bundle-reloading");
        setAuthLoading(false);
        return true;
      }
      return await connectRef.current(credentials, options);
    } catch (error) {
      setAuthLoading(false);
      const message = error instanceof Error ? error.message : "Pairing failed";
      setAuthError(message);
      if (options?.showAlert !== false) {
        Alert.alert("Pairing Failed", message);
      }
      return false;
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    let consumedDeepLink = false;

    const applyConnectUrl = async (rawUrl: string): Promise<boolean> => {
      const result = parseConnectDeepLink(rawUrl);
      if (result.kind === "error") {
        if (rawUrl.startsWith("natstack://connect")) {
          Alert.alert("Can't open connect link", result.reason);
        }
        return false;
      }
      smokePhase("workspace-deep-link-received");
      if (
        (await consumeConnectLinkReplay(rawUrl)) ||
        (await connectLinkMatchesStoredServer(result.serverUrl))
      ) {
        return false;
      }
      const confirmed = await confirmConnectDeepLink(result.serverUrl);
      if (!confirmed) return false;
      setServerUrl(result.serverUrl);
      setPairingCode(result.pairingCode);
      const connected = await pairAndConnect(result.serverUrl, result.pairingCode, {
        showAlert: true,
        connectLinkUrl: rawUrl,
      });
      consumedDeepLink = connected;
      return connected;
    };

    const connectLinkMatchesStoredServer = async (targetServerUrl: string): Promise<boolean> => {
      try {
        const credentials = await getCredentials();
        return isConnectLinkForStoredServer(targetServerUrl, credentials?.serverUrl ?? null);
      } catch {
        return false;
      }
    };

    const subscription = Linking.addEventListener("url", (event: { url: string }) => {
      void applyConnectUrl(event.url);
    });

    void (async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl && (await applyConnectUrl(initialUrl))) return;
        if (consumedDeepLink || cancelled) return;

        const bootstrap = await getConnectionBootstrap();
        if (!bootstrap || cancelled) return;

        setServerUrl(bootstrap.serverUrl);
        setPairingCode("");

        if (bootstrap.autoConnect) {
          setAutoConnecting(true);
          await connectRef.current(bootstrap, { showAlert: false });
        }
      } catch (error) {
        if (error instanceof StoredCredentialsNeedRepairError) {
          setAuthError(error.message);
          Alert.alert("Pairing Required", error.message);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          setAuthError(message);
        }
      } finally {
        if (!cancelled) {
          setBootstrapPending(false);
          setAutoConnecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const handleConnect = async () => {
    const trimmedUrl = serverUrl.trim();
    const trimmedCode = pairingCode.trim();

    if (!trimmedUrl) {
      Alert.alert("Missing URL", "Please enter your NatStack server URL.");
      return;
    }
    if (!trimmedCode) {
      Alert.alert("Missing Pairing Code", "Please enter the pairing code from your server.");
      return;
    }

    await pairAndConnect(trimmedUrl, trimmedCode, {
      showAlert: true,
    });
  };

  if (bootstrapPending || autoConnecting) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1, backgroundColor: colors.background }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.title, { color: colors.text }]}>NatStack</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {autoConnecting
              ? "Connecting to your NatStack server..."
              : "Loading development connection..."}
          </Text>
          <ActivityIndicator color={colors.primary} size="large" />
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>NatStack</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Connect to your NatStack server
        </Text>

        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface },
          ]}
          placeholder="Server URL (e.g. https://natstack.example.com)"
          placeholderTextColor={colors.textSecondary}
          value={serverUrl}
          onChangeText={setServerUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!authLoading}
        />

        <TextInput
          style={[
            styles.input,
            { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface },
          ]}
          placeholder="Pairing code"
          placeholderTextColor={colors.textSecondary}
          value={pairingCode}
          onChangeText={setPairingCode}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!authLoading}
        />

        <Pressable
          style={[
            styles.button,
            { backgroundColor: colors.primary },
            authLoading && styles.buttonDisabled,
          ]}
          onPress={handleConnect}
          disabled={authLoading}
        >
          {authLoading ? (
            <ActivityIndicator color="#e0e0e0" />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </Pressable>

        {authError && !authLoading ? (
          <Text style={[styles.errorText, { color: colors.danger }]} accessibilityRole="alert">
            {authError}
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
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
  },
  input: {
    width: "100%",
    height: 48,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
    fontSize: 16,
  },
  button: {
    width: "100%",
    height: 48,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    width: "100%",
    marginTop: 16,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
