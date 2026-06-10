// Shipped React Native host bootstrap.
//
// This file is intentionally not the workspace mobile app. It is the minimal
// native-host recovery surface used only when no approved workspace app bundle
// is active yet. The workspace app is fetched through NatStackMobileHost,
// verified by rnHostAbi + integrity, activated from native-owned storage, and
// then the RN bridge reloads onto that bundle.

import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppRegistry,
  Button,
  Linking,
  NativeModules,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { name as appName } from "./app.json";

const RN_HOST_ABI = "rn-host-1";
const nativeHost = NativeModules.NatStackMobileHost;

function platformName() {
  return Platform.OS === "ios" ? "ios" : "android";
}

function missingNativeHostError() {
  return new Error("NatStackMobileHost native module is unavailable");
}

function parseConnectDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return null;
  const queryStart = rawUrl.indexOf("?");
  if (queryStart < 0) throw new Error("Connect link is missing url or code");
  const params = parseQuery(rawUrl.slice(queryStart + 1));
  const serverUrl = params.get("url");
  const code = params.get("code");
  if (!serverUrl || !code) {
    throw new Error("Connect link is missing url or code");
  }
  return { serverUrl, code };
}

function parseQuery(query) {
  const params = new Map();
  for (const part of query.split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const rawKey = separator >= 0 ? part.slice(0, separator) : part;
    const rawValue = separator >= 0 ? part.slice(separator + 1) : "";
    params.set(decodeQueryComponent(rawKey), decodeQueryComponent(rawValue));
  }
  return params;
}

function decodeQueryComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw new Error("Connect link is invalid");
  }
}

async function activateApprovedWorkspaceApp(options = {}) {
  if (!nativeHost) throw missingNativeHostError();
  const credentials = await nativeHost.getCredentials();
  if (!credentials) {
    if (options.allowMissingCredentials) return false;
    throw new Error("Pair this device from the desktop app before loading the workspace app.");
  }
  await nativeHost.issueConnectionGrant();
  const prepared = await nativeHost.prepareAppBundle(RN_HOST_ABI, platformName(), null);
  await nativeHost.activatePreparedAppBundle(
    prepared.localPath,
    prepared.buildKey,
    prepared.integrity
  );
  return true;
}

async function pairAndActivateWorkspaceApp(rawUrl) {
  if (!nativeHost) throw missingNativeHostError();
  const parsed = parseConnectDeepLink(rawUrl);
  if (!parsed) return false;
  await pairAndActivateParsedLink(parsed);
  return true;
}

async function pairAndActivateParsedLink(parsed) {
  await nativeHost.completePairing(parsed.serverUrl, parsed.code, null);
  await activateApprovedWorkspaceApp();
}

function NatStackMobileHostBootstrap() {
  const [status, setStatus] = useState("Loading approved workspace app...");
  const [busy, setBusy] = useState(true);
  const [pendingConnect, setPendingConnect] = useState(null);

  const load = useCallback(async () => {
    setBusy(true);
    setStatus("Loading approved workspace app...");
    try {
      const initialUrl = await Linking.getInitialURL();
      const initialConnect = initialUrl ? parseConnectDeepLink(initialUrl) : null;
      if (initialConnect) {
        setPendingConnect(initialConnect);
        setStatus(`Pair this device with ${initialConnect.serverUrl}?`);
        return;
      }
      const activated = await activateApprovedWorkspaceApp();
      setStatus(
        activated
          ? "Workspace app activated. Reloading..."
          : "Pair this device from the desktop app."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const confirmPendingConnect = useCallback(async () => {
    if (!pendingConnect) return;
    setBusy(true);
    setStatus("Pairing device...");
    try {
      await pairAndActivateParsedLink(pendingConnect);
      setPendingConnect(null);
      setStatus("Workspace app activated. Reloading...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [pendingConnect]);

  const cancelPendingConnect = useCallback(() => {
    setPendingConnect(null);
    setStatus("Pairing cancelled.");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      try {
        const parsed = parseConnectDeepLink(event.url);
        if (!parsed) {
          setStatus("Open a NatStack connect link to pair this device.");
          return;
        }
        setPendingConnect(parsed);
        setStatus(`Pair this device with ${parsed.serverUrl}?`);
        setBusy(false);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
        setBusy(false);
      }
    });
    return () => subscription.remove();
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.panel}>
        <Text style={styles.title}>NatStack Mobile Host</Text>
        <Text style={styles.message}>{status}</Text>
        {busy ? (
          <ActivityIndicator />
        ) : pendingConnect ? (
          <View style={styles.actions}>
            <Button title="Pair" onPress={confirmPendingConnect} />
            <Button title="Cancel" onPress={cancelPendingConnect} />
          </View>
        ) : (
          <Button title="Retry" onPress={load} />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#101418",
    padding: 24,
  },
  panel: {
    width: "100%",
    maxWidth: 420,
    gap: 16,
  },
  actions: {
    gap: 12,
  },
  title: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "700",
  },
  message: {
    color: "#cbd5e1",
    fontSize: 16,
    lineHeight: 22,
  },
});

AppRegistry.registerComponent(appName, () => NatStackMobileHostBootstrap);
