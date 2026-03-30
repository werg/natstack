import React from "react";
import { View, Text, StyleSheet, Pressable, SafeAreaView } from "react-native";
import type { StackNavigationProp } from "@react-navigation/stack";
import { useAtomValue, useSetAtom } from "jotai";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { clearCredentials } from "../services/auth";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { serverUrlAtom, isAuthenticatedAtom } from "../state/authAtoms";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { connectionStatusAtom } from "../state/connectionAtoms";
import { themeColorsAtom } from "../state/themeAtoms";
import { ConnectionBar } from "./ConnectionBar";

type SettingsScreenNavigationProp = StackNavigationProp<RootStackParamList, "Settings">;

interface SettingsScreenProps {
  navigation: SettingsScreenNavigationProp;
}

export function SettingsScreen({ navigation }: SettingsScreenProps) {
  const shellClient = useAtomValue(shellClientAtom);
  const setShellClient = useSetAtom(shellClientAtom);
  const serverUrl = useAtomValue(serverUrlAtom);
  const connectionStatus = useAtomValue(connectionStatusAtom);
  const setAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);
  const colors = useAtomValue(themeColorsAtom);

  const handleDisconnect = async () => {
    // Dispose the shell client (stops sync, disconnects transport)
    shellClient?.dispose();
    setShellClient(null);
    setPanelTree([]);
    setActivePanelId(null);

    // Clear stored credentials
    await clearCredentials();
    setAuthenticated(false);

    navigation.replace("Login");
  };

  const handleBack = () => {
    navigation.goBack();
  };

  const statusLabel =
    connectionStatus === "connected"
      ? "Connected"
      : connectionStatus === "connecting"
        ? "Connecting..."
        : "Disconnected";

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ConnectionBar />

      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Pressable onPress={handleBack} style={styles.backButton}>
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Settings</Text>
          <View style={styles.backButton} />
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Connection</Text>
          <Text style={[styles.label, { color: colors.textSecondary }]}>
            Server: {serverUrl || "not configured"}
          </Text>
          <Text style={[styles.label, { color: colors.textSecondary }]}>
            Status: {statusLabel}
          </Text>
        </View>

        <Pressable
          style={[styles.disconnectButton, { backgroundColor: colors.danger }]}
          onPress={handleDisconnect}
        >
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 24,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 32,
  },
  backButton: {
    width: 60,
  },
  backText: {
    fontSize: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
  },
  label: {
    fontSize: 14,
    marginBottom: 6,
  },
  disconnectButton: {
    height: 48,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 16,
  },
  disconnectText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
});
