// Shipped React Native host bootstrap.
//
// This file is intentionally not the workspace mobile app. It is the minimal
// native-host recovery surface used only when no approved workspace app bundle
// is active yet. The workspace app is fetched through NatStackMobileHost,
// verified by rnHostAbi + integrity, activated from native-owned storage, and
// then the RN bridge reloads onto that bundle.

// Must precede any @natstack/rpc import: installs a TextDecoder polyfill that
// Hermes lacks (the WebRTC control-frame codec needs it).
import "@natstack/mobile-webrtc/polyfills";
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
import { parseConnectLink } from "@natstack/shared/connect";
import {
  establishWebRtcConnection,
  reconnectViaWebRtc,
  persistShellCredential,
  loadShellCredential,
  clearShellCredential,
  makeShellTokenProvider,
  deviceIdFromCallerId,
} from "@natstack/mobile-webrtc";
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


function parseConnectDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return null;
  const parsed = parseConnectLink(rawUrl);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  // New WebRTC pairing payload: a signaling rendezvous room + the server's pinned
  // DTLS fingerprint + a one-time pairing code (no server origin URL anymore).
  return {
    room: parsed.room,
    fp: parsed.fp,
    code: parsed.code,
    sig: parsed.sig,
    ice: parsed.ice,
    srv: parsed.srv,
  };
}

/** A human label for a pairing target (the QR carries no server origin). */
function pairingLabel(pairing) {
  if (pairing?.srv) return pairing.srv;
  try {
    return new URL(pairing.sig).host;
  } catch {
    return "this NatStack server";
  }
}

async function markConnectLinkConsumed(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("natstack://connect")) return;
  await AsyncStorage.setItem(
    CONSUMED_CONNECT_LINK_KEY,
    JSON.stringify({ url: rawUrl, consumedAt: Date.now() })
  );
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_CODES = (() => {
  const codes = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) codes[i] = B64_ALPHABET.charCodeAt(i);
  return codes;
})();

/** Standard base64-encode a Uint8Array (O(n), Hermes-safe — no btoa/Buffer). */
function uint8ToBase64(bytes) {
  const len = bytes.length;
  const out = new Uint8Array(Math.ceil(len / 3) * 4);
  let o = 0;
  const fullEnd = len - (len % 3);
  for (let i = 0; i < fullEnd; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_CODES[(n >> 18) & 63];
    out[o++] = B64_CODES[(n >> 12) & 63];
    out[o++] = B64_CODES[(n >> 6) & 63];
    out[o++] = B64_CODES[n & 63];
  }
  const rem = len - fullEnd;
  if (rem === 1) {
    const n = bytes[fullEnd] << 16;
    out[o++] = B64_CODES[(n >> 18) & 63];
    out[o++] = B64_CODES[(n >> 12) & 63];
    out[o++] = 61;
    out[o++] = 61;
  } else if (rem === 2) {
    const n = (bytes[fullEnd] << 16) | (bytes[fullEnd + 1] << 8);
    out[o++] = B64_CODES[(n >> 18) & 63];
    out[o++] = B64_CODES[(n >> 12) & 63];
    out[o++] = B64_CODES[(n >> 6) & 63];
    out[o++] = 61;
  }
  const parts = [];
  for (let p = 0; p < out.length; p += 0x8000) {
    parts.push(String.fromCharCode.apply(null, out.subarray(p, p + 0x8000)));
  }
  return parts.join("");
}

/** Pick the primary RN bundle artifact for this platform from the bootstrap manifest. */
function selectPrimaryArtifact(bootstrap, platform) {
  const artifacts = Array.isArray(bootstrap?.artifacts) ? bootstrap.artifacts : [];
  const artifact = artifacts.find((a) => a?.role === "primary" && a?.platform === platform);
  if (!artifact) {
    throw new Error(`No primary React Native bundle artifact for ${platform}`);
  }
  return artifact;
}

/**
 * Fetch + activate the approved workspace app bundle OVER THE WEBRTC PIPE.
 *
 * There is no reachable server URL in WebRTC mode, so the asset plane rides the
 * pipe too: the manifest (`/_r/s/auth/mobile-app-bootstrap`) and the bundle
 * artifact (`/_a/<buildKey>/...`) are both fetched via the `gateway.fetch`
 * streaming RPC (loopback fetch on the server, chunked over the bulk channel),
 * then handed to the native host (`prepareAppBundleFromBytes`) which verifies
 * integrity + writes the local file for `activatePreparedAppBundle` to reload.
 */
/** Drain a `ReadableStream<Uint8Array>` into a single `Uint8Array`. */
async function drainStream(body) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Fetch a gateway asset over the pipe and return its bytes. Uses `streamReadable`
 * (not `stream`) because RN's whatwg-fetch `Response` cannot consume a
 * `ReadableStream` body — we read the decoded stream directly via `getReader()`.
 */
async function gatewayFetchBytes(connection, descriptor) {
  const decoded = await connection.rpc.streamReadable("main", "gateway.fetch", [descriptor]);
  const bytes = await drainStream(decoded.body);
  if (decoded.status !== 200) {
    throw new Error(
      `gateway.fetch ${descriptor.path} failed (${decoded.status}): ` +
        new TextDecoder().decode(bytes).slice(0, 300)
    );
  }
  return bytes;
}

/**
 * Stream a gateway asset over the pipe straight into the native bundle file, a
 * chunk at a time. Buffering the whole multi-MB bundle and base64-ing it in one
 * shot would block the JS thread (the WebRTC keepalive would miss and the pipe
 * would drop) and choke the bridge — so each ~bulk-channel chunk is base64'd and
 * appended natively, yielding between chunks.
 */
async function streamArtifactToNative(connection, descriptor, buildKey, artifactPath) {
  const decoded = await connection.rpc.streamReadable("main", "gateway.fetch", [descriptor]);
  if (decoded.status !== 200) {
    const bytes = await drainStream(decoded.body);
    throw new Error(
      `bundle artifact fetch failed (${decoded.status}): ` +
        new TextDecoder().decode(bytes).slice(0, 300)
    );
  }
  // The server gzips the body on the wire (descriptor.gzip) to keep the transfer
  // small enough for react-native-webrtc's serialized bulk receive; the native host
  // decompresses before verifying the uncompressed integrity. The header confirms it.
  const gzipped = decoded.headers.some(
    (h) => h[0].toLowerCase() === "x-natstack-content-gzip" && h[1] === "1"
  );
  const reader = decoded.body.getReader();
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      await nativeHost.appendBundleChunk(uint8ToBase64(value), buildKey, artifactPath, first);
      first = false;
    }
  }
  if (first) throw new Error("bundle artifact stream was empty");
  return gzipped;
}

async function activateApprovedWorkspaceApp(connection, options = {}) {
  if (!nativeHost) throw missingNativeHostError();
  const stored = await loadShellCredential();
  if (!stored) {
    throw new Error(
      "Pair this device with a trusted NatStack server before loading the workspace app."
    );
  }

  // 1. Bootstrap manifest (the endpoint authenticates the device by its refresh
  //    credential in the body, even though the pipe is already a shell session).
  const bootstrapBody = {
    deviceId: stored.deviceId,
    refreshToken: stored.refreshToken,
  };
  if (typeof options.source === "string" && options.source.length > 0) {
    bootstrapBody.source = options.source;
  }
  const manifestBytes = await gatewayFetchBytes(connection, {
    path: "/_r/s/auth/mobile-app-bootstrap",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bootstrapBody),
  });
  const bootstrap = JSON.parse(new TextDecoder().decode(manifestBytes))?.bootstrap;
  if (!bootstrap) throw new Error("Mobile app bootstrap returned no manifest");
  if (bootstrap.rnHostAbi !== RN_HOST_ABI) {
    throw new Error(
      `React Native host ABI mismatch: expected ${RN_HOST_ABI}, got ${bootstrap.rnHostAbi}`
    );
  }
  smokePhase("embedded-bundle-activate-start");
  const buildKey = bootstrap.buildKey;
  const artifact = selectPrimaryArtifact(bootstrap, platformName());
  const integrity = artifact.integrity;
  // `url` is absolute on the server origin; its pathname is the gateway path.
  const artifactPath = new URL(artifact.url).pathname;
  const nativeArtifactPath = artifact.path ?? artifactPath;

  // 2. Stream the bundle straight into the native bundle file (chunked + gzipped on
  //    the wire) — bundles are multiple MB; see streamArtifactToNative for why we
  //    don't buffer and why we compress.
  const gzipped = await streamArtifactToNative(
    connection,
    { path: artifactPath, method: "GET", gzip: true },
    buildKey,
    nativeArtifactPath
  );

  // 3. Native: decompress if needed, verify the bundle's integrity, then activate.
  const prepared = await nativeHost.finalizeBundleWrite(integrity, gzipped);
  await nativeHost.activatePreparedAppBundle(prepared.localPath, buildKey, integrity);
  smokePhase("embedded-bundle-activate-complete");
  return true;
}

// ===========================================================================
// WebRTC connection layer — replaces the HTTP `/rpc` transport and the native
// HTTP pairing. The host joins the signaling room from the pairing link, pins
// the server's DTLS fingerprint, opens a `shell` session, and round-trips RPC
// envelopes over the same DTLS pipe the desktop/CLI use.
// ===========================================================================

// The shell-credential store + the WebRTC connect helpers
// (establishWebRtcConnection / reconnectViaWebRtc / persist+loadShellCredential /
// makeShellTokenProvider / deviceIdFromCallerId) now live in
// @natstack/mobile-webrtc, shared with the post-reload workspace app. Only the
// fresh-pairing flow below (which emits the smoke phases) stays here.

/** Fresh pairing: redeem the code, capture + persist the issued device credential. */
async function pairViaWebRtc(pairing) {
  smokePhase("embedded-pairing-start");
  const tokenProvider = makeShellTokenProvider(pairing, null);
  let pairedCredential = null;
  const connection = await establishWebRtcConnection(pairing, tokenProvider, {
    onPaired: (credential) => {
      // Fires inside the open handshake (before `ready()` resolves): switch the
      // token provider to the refresh secret so reconnects authenticate.
      pairedCredential = credential;
      tokenProvider.setCredential(credential);
    },
  });
  if (pairedCredential) {
    await persistShellCredential(pairedCredential, pairing);
    connection.deviceId = pairedCredential.deviceId;
  } else {
    // The server authenticated us but issued no fresh credential — we are
    // connected for this session but cannot persist a refresh secret. Surface
    // it loudly rather than pretending a reconnect will work.
    console.warn("[mobile-rtc] paired session returned no device credential to persist");
    connection.deviceId = deviceIdFromCallerId(connection.callerId);
  }
  smokePhase("embedded-pairing-complete");
  return connection;
}

async function rpc(connection, method, args = []) {
  // All control-plane RPC now rides the WebRTC session (target the server "main").
  return connection.rpc.call("main", method, args);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientLaunchRpcError(error) {
  const code = error?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    code === "PIPE_CLOSED" ||
    code === "CONNECTION_LOST" ||
    /timed out|pipe down|not connected|control channel not open/i.test(message)
  );
}

function isBootstrapReadinessError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /MOBILE_APP_APPROVAL_REQUIRED|MOBILE_APP_UNAVAILABLE|approval|required|not ready|not available/i.test(
    message
  );
}

async function launchGateRpc(connection, method, args, deadline) {
  let attempt = 0;
  for (;;) {
    try {
      return await connection.rpc.call("main", method, args, { timeoutMs: 15000 });
    } catch (error) {
      if (!isTransientLaunchRpcError(error) || Date.now() >= deadline) throw error;
      attempt += 1;
      await connection.session?.ready?.().catch(() => {});
      await delay(Math.min(5000, 500 * 2 ** Math.min(attempt, 4)));
    }
  }
}

/**
 * Launch-readiness event client over the WebRTC session. Subscribes to the
 * host-target launch events and lets the gate await the next change. Server
 * events are an optimization: each wait is capped so the gate falls back to
 * polling `getLaunchSession` at a bounded cadence (never a busy loop) if no
 * event arrives — polling guarantees progress.
 */
function createLaunchReadinessEventClient(connection) {
  const eventNames = HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS;
  const POLL_CAP_MS = 2000;
  let lastSession = null;
  let revision = 0;
  let observedRevision = 0;
  const waiters = new Set();
  const notify = () => {
    revision += 1;
    for (const waiter of Array.from(waiters)) waiter(true);
  };
  const unsubs = [];
  for (const name of eventNames) {
    unsubs.push(
      connection.rpc.on(name, (ev) => {
        const raw = typeof ev?.event === "string" ? ev.event : name;
        const eventName = raw.startsWith("event:") ? raw.slice("event:".length) : raw;
        if (isLaunchSessionEventForTarget("react-native", eventName, ev?.payload)) {
          lastSession = ev.payload;
          notify();
        }
      })
    );
    // Best-effort server-side subscription; the poll fallback covers a failure.
    void connection.rpc.call("main", "events.subscribe", [name]).catch(() => {});
  }
  return Promise.resolve({
    waitForLaunchSessionChange(sessionId, timeoutMs) {
      if (lastSession?.sessionId === sessionId && revision !== observedRevision) {
        observedRevision = revision;
        return Promise.resolve(lastSession);
      }
      const waitMs = Math.max(1, Math.min(timeoutMs, POLL_CAP_MS));
      return new Promise((waitResolve) => {
        const timer = setTimeout(() => {
          waiters.delete(done);
          waitResolve(null);
        }, waitMs);
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
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {}
      }
    },
  });
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

  const runLaunchGate = useCallback(async (grant, initialSession = null) => {
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
      if (!initialSession) {
        try {
          setStatus("Workspace app approved. Activating bundle...");
          await activateApprovedWorkspaceApp(grant);
          if (!isCurrent()) return;
          setStatus("Workspace app activated. Reloading...");
          return;
        } catch (error) {
          if (!isBootstrapReadinessError(error)) throw error;
        }
      }
      let session =
        initialSession ??
        (await launchGateRpc(grant, "workspace.hostTargets.beginLaunch", ["react-native"], deadline));
      for (;;) {
        if (!isCurrent()) return;
        setLaunchSession(session);
        setStatus(formatLaunchSessionStatus(session));
        if (!isCurrent()) return;
        if (session?.status === "ready") {
          setApprovals([]);
          setStatus("Workspace app approved. Activating bundle...");
          // Fetch + activate the bundle OVER THE PIPE (manifest + artifact via
          // gateway.fetch). Fails loud if it can't — pair/connect/RPC already
          // succeeded, so a bundle failure is a real error, not a soft "pending".
          await activateApprovedWorkspaceApp(grant, {
            source: session.launch?.source ?? null,
          });
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
          const refreshed = await launchGateRpc(
            grant,
            "workspace.hostTargets.getLaunchSession",
            [session.sessionId],
            deadline
          );
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
        if (decision === "once") {
          await runLaunchGate(launchGrant, session);
        } else {
          setLaunchSession(session);
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
      setStatus(`Pair this device with ${pairingLabel(parsed)}?`);
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

  const selectWorkspaceAndRun = useCallback(
    async (workspaceName, consumedUrl = null) => {
      setBusy(true);
      setStatus(`Opening ${workspaceName}...`);
      const grant = await nativeHost.selectWorkspace(workspaceName, null);
      smokePhase("embedded-workspace-selected");
      if (consumedUrl) {
        await markConnectLinkConsumed(consumedUrl).catch(() => {});
      }
      setPendingConnect(null);
      setPendingWorkspaces([]);
      await runLaunchGate(grant);
    },
    [runLaunchGate]
  );

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
      // A returning device reconnects over the SAME signaling room with its
      // stored refresh secret — no HTTP, no native credential read.
      const stored = await loadShellCredential();
      if (!stored) {
        setStatus(
          "Open a NatStack pairing link or scan a QR code from a trusted desktop or terminal."
        );
        return;
      }
      setStatus(`Reconnecting to ${pairingLabel(stored.pairing)}...`);
      const connection = await reconnectViaWebRtc(stored);
      await runLaunchGate(connection);
    } catch (error) {
      // A rejected refresh secret is terminal — drop it so the next launch asks
      // for a fresh QR instead of looping on a credential the server won't honor.
      if (error?.code === "SESSION_AUTH_FAILED") {
        await clearShellCredential().catch(() => {});
        setStatus("Your saved pairing was rejected. Scan a fresh NatStack QR code to re-pair.");
      } else {
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  }, [presentConnectLink, runLaunchGate, selectWorkspaceAndRun]);

  const confirmPendingConnect = useCallback(async () => {
    if (!pendingConnect) return;
    setBusy(true);
    setStatus("Pairing over a secure WebRTC pipe...");
    try {
      // Pair + connect over WebRTC: pin the server's DTLS fingerprint, redeem the
      // one-time code, persist the issued device credential. The signaling room
      // targets one workspace server, so we proceed straight to the launch gate.
      const connection = await pairViaWebRtc(pendingConnect);
      smokePhase("embedded-workspace-selected");
      if (pendingConnect.rawUrl) {
        await markConnectLinkConsumed(pendingConnect.rawUrl).catch(() => {});
      }
      setPendingConnect(null);
      setPendingWorkspaces([]);
      await runLaunchGate(connection);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [pendingConnect, runLaunchGate]);

  const selectPendingWorkspace = useCallback(
    async (workspaceName) => {
      try {
        await selectWorkspaceAndRun(workspaceName, pendingConnect?.rawUrl ?? null);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [pendingConnect, selectWorkspaceAndRun]
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
                <Text style={styles.hostLabel}>
                  {pendingConnect ? pairingLabel(pendingConnect) : "Paired server"}
                </Text>
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
                <Text style={styles.hostLabel}>{pairingLabel(pendingConnect)}</Text>
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
