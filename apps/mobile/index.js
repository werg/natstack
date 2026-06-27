// Shipped React Native host bootstrap.
//
// This file is intentionally not the workspace mobile app. It is the minimal
// native-host recovery surface used only when no approved workspace app bundle
// is active yet. The workspace app is fetched through NatStackMobileHost,
// verified by rnHostAbi + integrity, activated from native-owned storage, and
// then the RN bridge reloads onto that bundle.

import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppRegistry,
  Linking,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseConnectLink, serverRpcHttpUrl, serverRpcWsUrl } from "@natstack/shared/connect";
import {
  formatCapabilities,
  launchCopy,
  plural,
  unitKindLabel,
  unitReviewRows,
  unitSourceLabel,
  unitSummaryChips,
} from "@natstack/shared/bootstrapLaunchGate";
import {
  HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS,
  isLaunchSessionEventForTarget,
} from "@natstack/shared/hostTargetLaunchGate";
import { name as appName } from "./app.json";

const RN_HOST_ABI = "rn-host-1";
const CONSUMED_CONNECT_LINK_KEY = "natstack:connect:consumed-url";
const nativeHost = NativeModules.NatStackMobileHost;

function smokePhase(phase) {
  console.log(`[NatStackMobileSmoke] phase=${phase}`);
}

function platformName() {
  return Platform.OS === "ios" ? "ios" : "android";
}

function missingNativeHostError() {
  return new Error("NatStackMobileHost native module is unavailable");
}

function randomRequestId(prefix = "mobile-bootstrap") {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function callerKindFromId(callerId) {
  if (typeof callerId !== "string") return "app";
  if (callerId.startsWith("shell:")) return "shell";
  if (callerId.startsWith("app:") || callerId.startsWith("@workspace-apps/")) return "app";
  if (callerId.startsWith("panel:")) return "panel";
  if (callerId.startsWith("worker:")) return "worker";
  if (callerId.startsWith("do:")) return "do";
  if (callerId.startsWith("extension:")) return "extension";
  return "app";
}

function rpcCallerFromGrant(grant) {
  const callerId =
    typeof grant?.callerId === "string" && grant.callerId.length > 0
      ? grant.callerId
      : "mobile-host";
  return { callerId, callerKind: callerKindFromId(callerId) };
}

function rpcEnvelopeFromGrant(grant, message, target = "main") {
  const caller = rpcCallerFromGrant(grant);
  return {
    from: caller.callerId,
    target,
    delivery: { caller },
    provenance: [caller],
    message,
  };
}

function parseConnectDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return null;
  const parsed = parseConnectLink(rawUrl);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  return { serverUrl: parsed.url, code: parsed.code };
}

async function markConnectLinkConsumed(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return;
  await AsyncStorage.setItem(
    CONSUMED_CONNECT_LINK_KEY,
    JSON.stringify({ url: rawUrl, consumedAt: Date.now() })
  );
}

async function activateApprovedWorkspaceApp(options = {}) {
  if (!nativeHost) throw missingNativeHostError();
  const credentials = await nativeHost.getCredentials();
  if (!credentials) {
    if (options.allowMissingCredentials) return false;
    throw new Error(
      "Pair this device with a trusted NatStack server before loading the workspace app."
    );
  }
  smokePhase("embedded-bundle-activate-start");
  const prepared = await nativeHost.prepareAppBundle(
    RN_HOST_ABI,
    platformName(),
    options.source ?? null
  );
  await nativeHost.activatePreparedAppBundle(
    prepared.localPath,
    prepared.buildKey,
    prepared.integrity
  );
  smokePhase("embedded-bundle-activate-complete");
  return true;
}

async function rpc(grant, method, args = []) {
  const requestId = randomRequestId();
  const envelope = rpcEnvelopeFromGrant(grant, {
    type: "request",
    requestId,
    fromId: rpcCallerFromGrant(grant).callerId,
    method,
    args,
  });
  const response = await fetch(serverRpcHttpUrl(grant.serverUrl).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${grant.connectionGrant}`,
    },
    body: JSON.stringify(envelope),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `RPC ${method} failed with HTTP ${response.status}`);
  }
  const responseEnvelope = json?.envelope || json;
  const message = responseEnvelope?.message;
  if (!message) {
    throw new Error(json.error || `RPC ${method} returned a malformed response`);
  }
  if (message.error) throw new Error(String(message.error));
  if (!("result" in message)) throw new Error(`RPC ${method} returned a malformed response`);
  return message.result;
}

function rpcWsUrl(serverUrl) {
  return serverRpcWsUrl(serverUrl);
}

function isSelectedWorkspaceUrl(serverUrl) {
  try {
    return new URL(serverUrl).pathname.replace(/\/+$/, "").startsWith("/_workspace/");
  } catch {
    return false;
  }
}

function createLaunchReadinessEventClient(grant) {
  const eventNames = HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS;
  const callerId = grant.callerId || "mobile-host";
  return new Promise((resolve, reject) => {
    let ws = null;
    let settled = false;
    let lastSession = null;
    let revision = 0;
    let observedRevision = 0;
    let requestIndex = 0;
    const waiters = new Set();
    const notify = () => {
      revision += 1;
      for (const waiter of Array.from(waiters)) waiter(true);
    };
    const finishCreate = () => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimer);
      resolve({
        waitForLaunchSessionChange(sessionId, timeoutMs) {
          if (lastSession?.sessionId === sessionId && revision !== observedRevision) {
            observedRevision = revision;
            return Promise.resolve(lastSession);
          }
          return new Promise((waitResolve) => {
            const timer = setTimeout(() => {
              waiters.delete(done);
              waitResolve(null);
            }, timeoutMs);
            const done = (value) => {
              if (value) observedRevision = revision;
              clearTimeout(timer);
              waiters.delete(done);
              waitResolve(lastSession?.sessionId === sessionId ? lastSession : null);
            };
            waiters.add(done);
          });
        },
        close() {
          for (const waiter of Array.from(waiters)) waiter(false);
          waiters.clear();
          try {
            ws?.close();
          } catch {}
        },
      });
    };
    const failCreate = () => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimer);
      try {
        ws?.close();
      } catch {}
      reject(new Error("Mobile launch event stream is not available."));
    };
    const authTimer = setTimeout(failCreate, 10000);
    try {
      ws = new WebSocket(rpcWsUrl(grant.serverUrl));
    } catch {
      failCreate();
      return;
    }
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "ws:auth",
          token: grant.connectionGrant,
          clientLabel: "Mobile Host",
          clientPlatform: "mobile",
        })
      );
    };
    ws.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === "ws:auth-result") {
        if (message.success !== true) {
          failCreate();
          return;
        }
        for (const name of eventNames) {
          requestIndex += 1;
          const requestId = `bootstrap-event-${requestIndex}`;
          ws?.send(
            JSON.stringify({
              type: "ws:rpc",
              envelope: rpcEnvelopeFromGrant(grant, {
                type: "request",
                requestId,
                fromId: callerId,
                method: "events.subscribe",
                args: [name],
              }),
            })
          );
        }
        finishCreate();
        return;
      }
      if (message?.type === "ws:event") {
        const rawEvent = typeof message.event === "string" ? message.event : "";
        const eventName = rawEvent.startsWith("event:")
          ? rawEvent.slice("event:".length)
          : rawEvent;
        if (isLaunchSessionEventForTarget("react-native", eventName, message.payload)) {
          lastSession = message.payload;
          notify();
        }
      }
    };
    ws.onerror = failCreate;
    ws.onclose = () => {
      for (const waiter of Array.from(waiters)) waiter(false);
      waiters.clear();
    };
  });
}

async function pairParsedLink(parsed) {
  smokePhase("embedded-pairing-start");
  await nativeHost.pairServer(parsed.serverUrl, parsed.code);
  smokePhase("embedded-pairing-complete");
  const response = await nativeHost.listWorkspaces();
  return Array.isArray(response?.workspaces) ? response.workspaces : [];
}

function ActionButton({ title, onPress, variant = "primary", disabled = false }) {
  const buttonStyle =
    variant === "danger"
      ? styles.dangerButton
      : variant === "secondary"
        ? styles.secondaryButton
        : styles.primaryButton;
  const textStyle = variant === "primary" ? styles.primaryButtonText : styles.secondaryButtonText;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        buttonStyle,
        pressed && !disabled ? styles.buttonPressed : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={textStyle}>{title}</Text>
    </Pressable>
  );
}

function StepIndicator({ activeStep }) {
  const steps = [
    { id: "pair", label: "Pair" },
    { id: "approve", label: "Approve" },
    { id: "load", label: "Load" },
  ];
  return (
    <View style={styles.steps}>
      {steps.map((step) => {
        const active = step.id === activeStep;
        return (
          <View key={step.id} style={[styles.step, active ? styles.stepActive : null]}>
            <View style={[styles.stepDot, active ? styles.stepDotActive : null]} />
            <Text style={[styles.stepText, active ? styles.stepTextActive : null]}>
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function formatLaunchSessionStatus(session) {
  if (!session) return "Preparing secure workspace access";
  return [session.message, session.detail].filter(Boolean).join("\n");
}

function LaunchTimeline({ session }) {
  if (!session?.timeline?.length) return null;
  return (
    <View style={styles.timeline}>
      {session.timeline.map((phase) => (
        <View key={phase.id} style={styles.timelineRow}>
          <View style={[styles.timelineDot, styles[`timelineDot_${phase.state}`]]} />
          <View style={styles.timelineText}>
            <Text style={[styles.timelineLabel, styles[`timelineLabel_${phase.state}`]]}>
              {phase.label}
            </Text>
            {phase.detail ? <Text style={styles.timelineDetail}>{phase.detail}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function NatStackMobileHostBootstrap() {
  const [status, setStatus] = useState("Loading approved workspace app...");
  const [busy, setBusy] = useState(true);
  const [pendingConnect, setPendingConnect] = useState(null);
  const [pendingWorkspaces, setPendingWorkspaces] = useState([]);
  const [launchGrant, setLaunchGrant] = useState(null);
  const [launchSession, setLaunchSession] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [openApprovalIds, setOpenApprovalIds] = useState(() => new Set());
  const launchGateGeneration = useRef(0);

  const runLaunchGate = useCallback(async (grant) => {
    const generation = ++launchGateGeneration.current;
    const isCurrent = () => generation === launchGateGeneration.current;
    setBusy(true);
    setApprovals([]);
    setPendingWorkspaces([]);
    setOpenApprovalIds(new Set());
    setLaunchGrant(grant);
    const deadline = Date.now() + 120000;
    let eventClient = null;
    try {
      let session = await rpc(grant, "workspace.hostTargets.beginLaunch", ["react-native"]);
      for (;;) {
        if (!isCurrent()) return;
        setLaunchSession(session);
        setStatus(formatLaunchSessionStatus(session));
        if (!isCurrent()) return;
        if (session?.status === "ready") {
          setApprovals([]);
          setStatus("Workspace app approved. Activating bundle...");
          await activateApprovedWorkspaceApp({ source: session.launch?.source ?? null });
          if (!isCurrent()) return;
          setStatus("Workspace app activated. Reloading...");
          return;
        }
        if (session?.status === "approval-required") {
          smokePhase("embedded-host-target-approval-required");
          setApprovals(Array.isArray(session.approvals) ? session.approvals : []);
          setStatus(formatLaunchSessionStatus(session));
          return;
        }
        if (session?.status === "preparing" || session?.status === "starting") {
          smokePhase("embedded-host-target-preparing");
          if (!eventClient) {
            eventClient = await createLaunchReadinessEventClient(grant).catch(() => null);
          }
          const observed = eventClient
            ? await eventClient.waitForLaunchSessionChange(
                session.sessionId,
                Math.max(1, deadline - Date.now())
              )
            : null;
          if (!isCurrent()) return;
          if (observed) {
            session = observed;
            continue;
          }
          const refreshed = await rpc(grant, "workspace.hostTargets.getLaunchSession", [
            session.sessionId,
          ]);
          if (!isCurrent()) return;
          if (refreshed) {
            session = refreshed;
            continue;
          }
        }
        setApprovals([]);
        setStatus(formatLaunchSessionStatus(session));
        return;
      }
    } finally {
      eventClient?.close();
    }
  }, []);

  const resolveLaunchApprovals = useCallback(
    async (decision) => {
      if (!launchGrant) return;
      if (!launchSession?.sessionId) return;
      setBusy(true);
      setStatus(decision === "once" ? "Approving workspace app..." : "Denying workspace app...");
      try {
        const session = await rpc(
          launchGrant,
          "workspace.hostTargets.resolveLaunchSessionApproval",
          [launchSession.sessionId, decision]
        );
        setLaunchSession(session);
        setApprovals(Array.isArray(session?.approvals) ? session.approvals : []);
        if (decision === "once") {
          await runLaunchGate(launchGrant);
        } else {
          setApprovals([]);
          setStatus("Workspace app approval denied.");
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [launchGrant, launchSession, runLaunchGate]
  );

  const presentConnectLink = useCallback((rawUrl) => {
    try {
      const parsed = parseConnectDeepLink(rawUrl);
      if (!parsed) {
        setPendingConnect(null);
        setStatus("Open a NatStack connect link to pair this device.");
        setBusy(false);
        return;
      }
      smokePhase("embedded-deep-link-received");
      setPendingConnect({ ...parsed, rawUrl });
      setStatus(`Pair this device with ${parsed.serverUrl}?`);
      setBusy(false);
    } catch (error) {
      setPendingConnect(null);
      setStatus(
        `${
          error instanceof Error ? error.message : String(error)
        }\n\nScan a fresh NatStack pairing QR code to re-pair this device.`
      );
      setBusy(false);
    }
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setApprovals([]);
    setLaunchSession(null);
    setStatus("Loading approved workspace app...");
    try {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl && initialUrl.startsWith("natstack://connect")) {
        presentConnectLink(initialUrl);
        return;
      }
      if (!nativeHost) throw missingNativeHostError();
      const credentials = await nativeHost.getCredentials();
      if (!credentials) {
        setStatus(
          "Open a NatStack pairing link or scan a QR code from a trusted desktop or terminal."
        );
        return;
      }
      if (!credentials.workspaceName && !credentials.workspaceId) {
        const response = await nativeHost.listWorkspaces();
        setPendingWorkspaces(Array.isArray(response?.workspaces) ? response.workspaces : []);
        setStatus("Choose a workspace on the paired server.");
        return;
      }
      if (credentials.workspaceId && !isSelectedWorkspaceUrl(credentials.serverUrl)) {
        await nativeHost.clearCredentials?.().catch(() => {});
        setStatus(
          "Stored mobile credentials are not scoped to a workspace. Scan a new pairing QR code."
        );
        return;
      }
      const grant = await nativeHost.issueConnectionGrant();
      await runLaunchGate(grant);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [presentConnectLink, runLaunchGate]);

  const confirmPendingConnect = useCallback(async () => {
    if (!pendingConnect) return;
    setBusy(true);
    setStatus("Pairing server...");
    try {
      const workspaces = await pairParsedLink(pendingConnect);
      setPendingWorkspaces(workspaces);
      setStatus(
        workspaces.length > 0
          ? "Choose a workspace on the paired server."
          : "The paired server has no workspaces available."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [pendingConnect]);

  const selectPendingWorkspace = useCallback(
    async (workspaceName) => {
      setBusy(true);
      setStatus(`Opening ${workspaceName}...`);
      try {
        const grant = await nativeHost.selectWorkspace(workspaceName, null);
        smokePhase("embedded-workspace-selected");
        if (pendingConnect?.rawUrl) {
          await markConnectLinkConsumed(pendingConnect.rawUrl).catch(() => {});
        }
        setPendingConnect(null);
        setPendingWorkspaces([]);
        await runLaunchGate(grant);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [pendingConnect, runLaunchGate]
  );

  const cancelPendingConnect = useCallback(() => {
    setPendingConnect(null);
    setPendingWorkspaces([]);
    setStatus("Pairing cancelled.");
  }, []);

  const toggleApprovalDetails = useCallback((approvalId) => {
    setOpenApprovalIds((current) => {
      const next = new Set(current);
      if (next.has(approvalId)) next.delete(approvalId);
      else next.add(approvalId);
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      presentConnectLink(event.url);
    });
    return () => subscription.remove();
  }, [presentConnectLink]);

  const activeStep =
    approvals.length > 0
      ? "approve"
      : pendingConnect || pendingWorkspaces.length > 0
        ? "pair"
        : "load";

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.panel}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>N</Text>
            </View>
            <View style={styles.brandText}>
              <Text style={styles.eyebrow}>NatStack</Text>
              <Text style={styles.title}>Mobile Host</Text>
            </View>
          </View>
          <View style={styles.statusPanel}>
            <StepIndicator activeStep={activeStep} />
            <Text style={styles.message}>{status}</Text>
            <LaunchTimeline session={launchSession} />
            {busy ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#78d4ff" />
                <Text style={styles.loadingText}>Preparing secure workspace access</Text>
              </View>
            ) : null}
          </View>
          {busy ? null : approvals.length > 0 ? (
            <View style={styles.actions}>
              <View style={styles.sectionHeader}>
                <Text style={styles.eyebrow}>Workspace trust</Text>
                <Text style={styles.sectionTitle}>Review before running workspace code</Text>
              </View>
              <View style={styles.approvalBox}>
                {approvals.map((approval, approvalIndex) => {
                  const units = Array.isArray(approval?.units) ? approval.units : [];
                  const id = approval.approvalId ?? `approval-${approvalIndex}`;
                  const copy = launchCopy(approval);
                  const detailsOpen = openApprovalIds.has(id);
                  return (
                    <View key={id} style={styles.approvalGroup}>
                      <Text style={styles.approvalGroupTitle}>{copy.title}</Text>
                      <Text style={styles.approval}>{copy.summary}</Text>
                      <View style={styles.unitSummary}>
                        <Text style={styles.unitChip}>
                          {plural(units.length, "privileged unit")}
                        </Text>
                        {unitSummaryChips(approval).map((chip) => (
                          <Text key={chip} style={styles.unitChip}>
                            {chip}
                          </Text>
                        ))}
                      </View>
                      <ActionButton
                        title={detailsOpen ? "Hide details" : "Review details"}
                        onPress={() => toggleApprovalDetails(id)}
                        variant="secondary"
                      />
                      {detailsOpen && units.length > 0
                        ? units.map((unit, unitIndex) => {
                            const row = unitReviewRows(approval)[unitIndex];
                            return (
                              <View
                                key={`${id}:${unit.unitName ?? unit.displayName ?? unitIndex}`}
                                style={styles.unitCard}
                              >
                                <View style={styles.unitHeader}>
                                  <Text style={styles.unitName}>
                                    {row?.name ||
                                      unit.displayName ||
                                      unit.unitName ||
                                      "Workspace unit"}
                                  </Text>
                                  <Text style={styles.unitBadge}>{unitKindLabel(unit)}</Text>
                                </View>
                                <Text style={styles.unitMeta}>{unitSourceLabel(unit)}</Text>
                                <Text style={styles.unitMeta}>{formatCapabilities(unit)}</Text>
                              </View>
                            );
                          })
                        : null}
                    </View>
                  );
                })}
              </View>
              <ActionButton
                title="Trust and start"
                onPress={() => resolveLaunchApprovals("once")}
              />
              <ActionButton
                title="Deny"
                onPress={() => resolveLaunchApprovals("deny")}
                variant="danger"
              />
            </View>
          ) : pendingWorkspaces.length > 0 ? (
            <View style={styles.actions}>
              <View style={styles.connectCard}>
                <Text style={styles.eyebrow}>Workspace</Text>
                <Text style={styles.sectionTitle}>Choose a workspace</Text>
                <Text style={styles.hostLabel}>{pendingConnect?.serverUrl ?? "Paired server"}</Text>
              </View>
              {pendingWorkspaces.map((workspace) => (
                <Pressable
                  key={workspace.name}
                  accessibilityRole="button"
                  onPress={() => selectPendingWorkspace(workspace.name)}
                  style={({ pressed }) => [
                    styles.workspaceButton,
                    pressed ? styles.buttonPressed : null,
                  ]}
                >
                  <View>
                    <Text style={styles.workspaceName}>{workspace.name}</Text>
                    <Text style={styles.workspaceMeta}>
                      {[
                        workspace.ephemeral ? "temporary" : "saved",
                        workspace.running ? "running" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                </Pressable>
              ))}
              <ActionButton title="Cancel" onPress={cancelPendingConnect} variant="secondary" />
            </View>
          ) : pendingConnect ? (
            <View style={styles.actions}>
              <View style={styles.connectCard}>
                <Text style={styles.eyebrow}>Pairing request</Text>
                <Text style={styles.sectionTitle}>Connect this device?</Text>
                <Text style={styles.hostLabel}>{pendingConnect.serverUrl}</Text>
              </View>
              <ActionButton title="Pair" onPress={confirmPendingConnect} />
              <ActionButton title="Cancel" onPress={cancelPendingConnect} variant="secondary" />
            </View>
          ) : (
            <View style={styles.actions}>
              <Text style={styles.hint}>
                Open a NatStack pairing link or scan a QR code from a trusted desktop or terminal.
              </Text>
              <ActionButton title="Retry" onPress={load} variant="secondary" />
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#12141b",
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },
  panel: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    gap: 16,
  },
  brandRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  brandMark: {
    alignItems: "center",
    backgroundColor: "#78d4ff",
    borderRadius: 8,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  brandMarkText: {
    color: "#071522",
    fontSize: 20,
    fontWeight: "800",
  },
  brandText: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    color: "#aab6c8",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  actions: {
    gap: 12,
  },
  title: {
    color: "#f8fafc",
    fontSize: 26,
    fontWeight: "800",
  },
  statusPanel: {
    backgroundColor: "#1a1f2b",
    borderColor: "#303a4f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  message: {
    color: "#e6eaf2",
    fontSize: 16,
    lineHeight: 23,
  },
  timeline: {
    borderColor: "#303a4f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  timelineRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
  },
  timelineDot: {
    backgroundColor: "#63708a",
    borderRadius: 999,
    height: 9,
    marginTop: 5,
    width: 9,
  },
  timelineDot_complete: {
    backgroundColor: "#7dd3a7",
  },
  timelineDot_active: {
    backgroundColor: "#facc6b",
  },
  timelineDot_failed: {
    backgroundColor: "#f87171",
  },
  timelineDot_blocked: {
    backgroundColor: "#f87171",
  },
  timelineDot_skipped: {
    backgroundColor: "#4b5568",
  },
  timelineText: {
    flex: 1,
  },
  timelineLabel: {
    color: "#aab6c8",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18,
  },
  timelineLabel_complete: {
    color: "#bdf4d3",
  },
  timelineLabel_active: {
    color: "#fff3bd",
  },
  timelineLabel_failed: {
    color: "#fecaca",
  },
  timelineLabel_blocked: {
    color: "#fecaca",
  },
  timelineLabel_skipped: {
    color: "#7d8796",
  },
  timelineDetail: {
    color: "#8d9bb0",
    fontSize: 12,
    lineHeight: 17,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  loadingText: {
    color: "#aab6c8",
    flex: 1,
    fontSize: 13,
  },
  steps: {
    flexDirection: "row",
    gap: 8,
  },
  step: {
    alignItems: "center",
    borderColor: "#33415c",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  stepActive: {
    backgroundColor: "#243347",
    borderColor: "#78d4ff",
  },
  stepDot: {
    backgroundColor: "#63708a",
    borderRadius: 999,
    height: 6,
    width: 6,
  },
  stepDotActive: {
    backgroundColor: "#78d4ff",
  },
  stepText: {
    color: "#aab6c8",
    fontSize: 12,
    fontWeight: "700",
  },
  stepTextActive: {
    color: "#f5fbff",
  },
  sectionHeader: {
    gap: 3,
  },
  sectionTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "800",
    lineHeight: 24,
  },
  approval: {
    color: "#e6eaf2",
    fontSize: 14,
    lineHeight: 20,
  },
  approvalBox: {
    backgroundColor: "#181d27",
    borderColor: "#343d51",
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  approvalGroup: {
    gap: 10,
  },
  approvalGroupTitle: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "800",
  },
  unitSummary: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  unitChip: {
    backgroundColor: "#253143",
    borderColor: "#40536f",
    borderRadius: 999,
    borderWidth: 1,
    color: "#e8eef7",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  unitCard: {
    backgroundColor: "#111722",
    borderColor: "#303a4f",
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
    padding: 10,
  },
  unitHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "space-between",
  },
  unitName: {
    color: "#f8fafc",
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700",
  },
  unitBadge: {
    backgroundColor: "#2a2416",
    borderColor: "#7c5e1e",
    borderRadius: 999,
    borderWidth: 1,
    color: "#fde68a",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  unitMeta: {
    color: "#aab6c8",
    fontSize: 13,
    lineHeight: 18,
  },
  connectCard: {
    backgroundColor: "#1b202b",
    borderColor: "#3a455d",
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  hostLabel: {
    color: "#e6eaf2",
    fontSize: 14,
    lineHeight: 20,
  },
  workspaceButton: {
    backgroundColor: "#18202b",
    borderColor: "#36465f",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  workspaceName: {
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 22,
  },
  workspaceMeta: {
    color: "#9eabc0",
    fontSize: 13,
    lineHeight: 18,
  },
  hint: {
    color: "#aab6c8",
    fontSize: 14,
    lineHeight: 20,
  },
  actionButton: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primaryButton: {
    backgroundColor: "#78d4ff",
    borderColor: "#78d4ff",
  },
  secondaryButton: {
    backgroundColor: "#202633",
    borderColor: "#3a455d",
  },
  dangerButton: {
    backgroundColor: "#321e25",
    borderColor: "#a24b5a",
  },
  primaryButtonText: {
    color: "#071522",
    fontSize: 15,
    fontWeight: "800",
  },
  secondaryButtonText: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "800",
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
});

AppRegistry.registerComponent(appName, () => NatStackMobileHostBootstrap);
