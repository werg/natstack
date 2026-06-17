import React from "react";
import {
  View,
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
  clearCredentials,
  completePairing,
  StoredCredentialsNeedRepairError,
  type Credentials,
} from "../services/auth";
import { getConnectionBootstrap } from "../services/connectionBootstrap";
import { MobileHostTargetApprovalRequiredError, ShellClient } from "../services/shellClient";
import {
  consumeConnectLinkReplay,
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
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";
import type { HostTargetLaunchSessionSnapshot } from "@natstack/shared/hostTargets";
import {
  formatCapabilities,
  launchCopy,
  plural,
  unitKindLabel,
  unitReviewRows,
  unitSourceLabel,
  unitSummaryChips,
} from "@natstack/shared/bootstrapLaunchGate";

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

function confirmManualRepair(reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Can't open connect link",
      `${reason}\n\nDo you want to clear the saved pairing and scan a fresh NatStack QR code?`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Re-pair", style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

type LoginScreenNavigationProp = StackNavigationProp<RootStackParamList, "Login">;

interface LoginScreenProps {
  navigation: LoginScreenNavigationProp;
}

interface HostApprovalState {
  client: ShellClient;
  credentials: Credentials;
  launchSession: HostTargetLaunchSessionSnapshot;
  approvals: PendingUnitBatchApproval[];
  busy: boolean;
  error: string | null;
}

export function LoginScreen({ navigation }: LoginScreenProps) {
  const [serverUrl, setServerUrl] = React.useState("");
  const [pairingCode, setPairingCode] = React.useState("");
  const [bootstrapPending, setBootstrapPending] = React.useState(true);
  const [autoConnecting, setAutoConnecting] = React.useState(false);
  const [hostApproval, setHostApproval] = React.useState<HostApprovalState | null>(null);
  const [openApprovalIds, setOpenApprovalIds] = React.useState<Set<string>>(() => new Set());
  const hostApprovalRef = React.useRef<HostApprovalState | null>(null);
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

  React.useEffect(() => {
    hostApprovalRef.current = hostApproval;
  }, [hostApproval]);

  const finishConnectedClient = (client: ShellClient, credentials: Credentials) => {
    smokePhase("workspace-connected");
    client.startPeriodicSync();

    setShellClient(client);
    setServerUrlAtom(credentials.serverUrl);
    setAuthenticated(true);
    setAuthLoading(false);
    setHostApproval(null);
    setOpenApprovalIds(new Set());

    navigation.replace("Main");
  };

  // Reusable connect logic shared by auto-connect and manual button
  const connectWithCredentials = async (
    credentials: Credentials,
    options?: { showAlert?: boolean }
  ): Promise<boolean> => {
    setAuthLoading(true);
    setAuthError(null);
    hostApprovalRef.current?.client.dispose();
    setHostApproval(null);
    const client = new ShellClient({
      credentials,
      onStatusChange: (status) => {
        setConnectionStatus(status);
      },
      onTreeUpdated: (tree) => {
        setPanelTree(tree);
      },
    });

    try {
      await client.init();
      finishConnectedClient(client, credentials);
      return true;
    } catch (error) {
      if (error instanceof MobileHostTargetApprovalRequiredError) {
        setHostApproval({
          client,
          credentials,
          launchSession: error.launchSession,
          approvals: error.approvals,
          busy: false,
          error: null,
        });
        setOpenApprovalIds(new Set());
        setAuthLoading(false);
        return false;
      }
      client.dispose();
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

  const resolveHostApproval = async (decision: "once" | "deny") => {
    if (!hostApproval) return;
    const { client, credentials, launchSession } = hostApproval;
    setHostApproval({ ...hostApproval, busy: true, error: null });
    setAuthLoading(true);
    try {
      await client.workspaces.resolveHostTargetLaunchSessionApproval(
        launchSession.sessionId,
        decision
      );
      if (decision === "deny") {
        client.dispose();
        setHostApproval(null);
        setAuthError("Workspace app approval denied.");
        return;
      }
      await client.init();
      finishConnectedClient(client, credentials);
    } catch (error) {
      if (error instanceof MobileHostTargetApprovalRequiredError) {
        setOpenApprovalIds(new Set());
        setHostApproval((current) =>
          current?.client === client
            ? {
                ...current,
                launchSession: error.launchSession,
                approvals: error.approvals,
                busy: false,
                error: null,
              }
            : current
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setHostApproval((current) =>
        current?.client === client ? { ...current, busy: false, error: message } : current
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const toggleApprovalDetails = React.useCallback((approvalId: string) => {
    setOpenApprovalIds((current) => {
      const next = new Set(current);
      if (next.has(approvalId)) next.delete(approvalId);
      else next.add(approvalId);
      return next;
    });
  }, []);

  const pairAndConnect = async (
    targetUrl: string,
    code: string,
    options?: { showAlert?: boolean; connectLinkUrl?: string }
  ): Promise<boolean> => {
    setAuthLoading(true);
    setAuthError(null);
    let pairingCompleted = false;
    try {
      const credentials = await completePairing(targetUrl, code);
      pairingCompleted = true;
      smokePhase("workspace-pairing-complete");
      if (options?.connectLinkUrl) {
        await markConnectLinkConsumed(options.connectLinkUrl).catch(() => {});
      }
      return await connectRef.current(credentials, options);
    } catch (error) {
      if (pairingCompleted) {
        await clearCredentials().catch(() => {});
      }
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
          const repair = await confirmManualRepair(result.reason);
          if (repair) {
            await clearCredentials().catch(() => {});
            setServerUrl("");
            setPairingCode("");
            setAuthError("Scan a fresh NatStack pairing QR code to reconnect this device.");
          }
        }
        return false;
      }
      smokePhase("workspace-deep-link-received");
      if (await consumeConnectLinkReplay(rawUrl)) {
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

  if (hostApproval) {
    const busy = hostApproval.busy || authLoading;
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1, backgroundColor: colors.background }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.title, { color: colors.text }]}>
            Do you trust the code in this workspace?
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Review the workspace code that wants to run on this device.
          </Text>
          <View
            style={[
              styles.approvalBox,
              { borderColor: colors.border, backgroundColor: colors.surface },
            ]}
          >
            {hostApproval.approvals.map((approval) => {
              const copy = launchCopy(approval);
              const detailsOpen = openApprovalIds.has(approval.approvalId);
              return (
                <View key={approval.approvalId} style={styles.approvalGroup}>
                  <Text style={[styles.approvalGroupTitle, { color: colors.text }]}>
                    {copy.title}
                  </Text>
                  <Text style={[styles.unitMeta, { color: colors.textSecondary }]}>
                    {copy.summary}
                  </Text>
                  <View style={styles.unitSummary}>
                    <Text
                      style={[styles.unitBadge, { color: colors.text, borderColor: colors.border }]}
                    >
                      {plural(approval.units.length, "privileged unit")}
                    </Text>
                    {unitSummaryChips(approval).map((chip) => (
                      <Text
                        key={chip}
                        style={[
                          styles.unitBadge,
                          { color: colors.text, borderColor: colors.border },
                        ]}
                      >
                        {chip}
                      </Text>
                    ))}
                  </View>
                  <Pressable
                    style={[
                      styles.secondaryButton,
                      styles.inlineSecondaryButton,
                      { borderColor: colors.border },
                      busy && styles.buttonDisabled,
                    ]}
                    onPress={() => toggleApprovalDetails(approval.approvalId)}
                    disabled={busy}
                  >
                    <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
                      {detailsOpen ? "Hide details" : "Review details"}
                    </Text>
                  </Pressable>
                  {detailsOpen
                    ? approval.units.map((unit, index) => {
                        const row = unitReviewRows(approval)[index]!;
                        return (
                          <View
                            key={`${approval.approvalId}:${unit.unitName}`}
                            style={[styles.unitCard, { borderColor: colors.border }]}
                          >
                            <View style={styles.unitHeader}>
                              <Text style={[styles.approvalItem, { color: colors.text }]}>
                                {row.name}
                              </Text>
                              <Text
                                style={[
                                  styles.unitBadge,
                                  { color: colors.text, borderColor: colors.border },
                                ]}
                              >
                                {unitKindLabel(unit)}
                              </Text>
                            </View>
                            <Text style={[styles.unitMeta, { color: colors.textSecondary }]}>
                              {unitSourceLabel(unit)}
                            </Text>
                            <Text style={[styles.unitMeta, { color: colors.textSecondary }]}>
                              {formatCapabilities(unit)}
                            </Text>
                          </View>
                        );
                      })
                    : null}
                </View>
              );
            })}
          </View>
          <Pressable
            style={[
              styles.button,
              { backgroundColor: colors.primary },
              busy && styles.buttonDisabled,
            ]}
            onPress={() => resolveHostApproval("once")}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#e0e0e0" />
            ) : (
              <Text style={styles.buttonText}>Trust and start</Text>
            )}
          </Pressable>
          <Pressable
            style={[
              styles.secondaryButton,
              { borderColor: colors.border },
              busy && styles.buttonDisabled,
            ]}
            onPress={() => resolveHostApproval("deny")}
            disabled={busy}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Deny</Text>
          </Pressable>
          {hostApproval.error ? (
            <Text style={[styles.errorText, { color: colors.danger }]} accessibilityRole="alert">
              {hostApproval.error}
            </Text>
          ) : null}
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
  secondaryButton: {
    width: "100%",
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 8,
  },
  inlineSecondaryButton: {
    height: 40,
    marginTop: 0,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  approvalBox: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    gap: 8,
  },
  approvalGroup: {
    width: "100%",
    gap: 8,
  },
  approvalGroupTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  unitCard: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 6,
  },
  unitHeader: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  unitSummary: {
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  approvalItem: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
  },
  unitBadge: {
    flexShrink: 0,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 12,
    fontWeight: "600",
  },
  unitMeta: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    width: "100%",
    marginTop: 16,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
