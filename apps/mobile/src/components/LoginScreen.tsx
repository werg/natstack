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
import { saveCredentials, getCredentials } from "../services/auth";
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
import { parseConnectDeepLink } from "../services/deepLinkConnect";

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
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

type LoginScreenNavigationProp = StackNavigationProp<RootStackParamList, "Login">;

interface LoginScreenProps {
  navigation: LoginScreenNavigationProp;
}

export function LoginScreen({ navigation }: LoginScreenProps) {
  const [serverUrl, setServerUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const colors = useAtomValue(themeColorsAtom);

  const setServerUrlAtom = useSetAtom(serverUrlAtom);
  const setAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setAuthLoading = useSetAtom(authLoadingAtom);
  const setAuthError = useSetAtom(authErrorAtom);
  const setConnectionStatus = useSetAtom(connectionStatusAtom);
  const setShellClient = useSetAtom(shellClientAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const authLoading = useAtomValue(authLoadingAtom);

  // Reusable connect logic shared by auto-connect and manual button
  const connectWithCredentials = async (url: string, authToken: string) => {
    setAuthLoading(true);
    setAuthError(null);

    try {
      const client = new ShellClient({
        serverUrl: url,
        shellToken: authToken,
        onStatusChange: (status) => {
          setConnectionStatus(status);
        },
        onTreeUpdated: (tree) => {
          setPanelTree(tree);
        },
      });

      await client.init();
      client.startPeriodicSync();

      setShellClient(client);
      setServerUrlAtom(url);
      setAuthenticated(true);
      setAuthLoading(false);

      navigation.replace("Main");
    } catch (error) {
      setAuthLoading(false);
      const message = error instanceof Error ? error.message : "Connection failed";
      setAuthError(message);
      Alert.alert("Connection Failed", message);
    }
  };

  // Keep a ref so the mount effect always calls the latest version
  const connectRef = React.useRef(connectWithCredentials);
  connectRef.current = connectWithCredentials;

  // Try loading saved credentials on mount and auto-connect if available.
  // Deep-link (natstack://connect?url=&token=) takes precedence but always
  // requires user confirmation before it overwrites creds — see
  // confirmConnectDeepLink above for the rationale.
  React.useEffect(() => {
    let consumedDeepLink = false;

    const applyConnectUrl = async (rawUrl: string): Promise<boolean> => {
      const result = parseConnectDeepLink(rawUrl);
      if (result.kind === "error") {
        if (rawUrl.startsWith("natstack://connect")) {
          // Surface the reason if someone clearly meant to send a connect link
          // but got rejected (bad host, missing token, …). Silent-ignore for
          // other natstack:// paths (oauth-callback etc).
          Alert.alert("Can't open connect link", result.reason);
        }
        return false;
      }
      const confirmed = await confirmConnectDeepLink(result.serverUrl);
      if (!confirmed) return false;
      consumedDeepLink = true;
      setServerUrl(result.serverUrl);
      setToken(result.shellToken);
      await saveCredentials(result.serverUrl, result.shellToken);
      await connectRef.current(result.serverUrl, result.shellToken);
      return true;
    };

    const subscription = Linking.addEventListener("url", (event: { url: string }) => {
      void applyConnectUrl(event.url);
    });

    void (async () => {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl && (await applyConnectUrl(initialUrl))) return;

      const creds = await getCredentials();
      if (!creds || consumedDeepLink) return;
      setServerUrl(creds.serverUrl);
      setToken(creds.token);
      if (creds.serverUrl && creds.token) {
        await connectRef.current(creds.serverUrl, creds.token);
      }
    })();

    return () => {
      subscription.remove();
    };
  }, []);

  const handleConnect = async () => {
    const trimmedUrl = serverUrl.trim();
    const trimmedToken = token.trim();

    if (!trimmedUrl) {
      Alert.alert("Missing URL", "Please enter your NatStack server URL.");
      return;
    }
    if (!trimmedToken) {
      Alert.alert("Missing Token", "Please enter the shell token from your server.");
      return;
    }

    await saveCredentials(trimmedUrl, trimmedToken);
    await connectWithCredentials(trimmedUrl, trimmedToken);
  };

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
          Connect to your NatStack server
        </Text>

        <TextInput
          style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]}
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
          style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]}
          placeholder="Shell token"
          placeholderTextColor={colors.textSecondary}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!authLoading}
        />

        <Pressable
          style={[styles.button, { backgroundColor: colors.primary }, authLoading && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={authLoading}
        >
          {authLoading ? (
            <ActivityIndicator color="#e0e0e0" />
          ) : (
            <Text style={styles.buttonText}>Connect</Text>
          )}
        </Pressable>
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
});
