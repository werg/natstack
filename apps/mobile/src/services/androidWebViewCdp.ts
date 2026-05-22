import { NativeModules, Platform } from "react-native";

export interface AndroidWebViewCdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

interface WebViewCdpProxyNative {
  start(): Promise<{ host?: string; port: number; socketName?: string }>;
  stop(): Promise<void>;
}

interface DevtoolsTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

const nativeProxy = NativeModules["WebViewCdpProxy"] as WebViewCdpProxyNative | undefined;

function normalizeUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function scoreTarget(target: DevtoolsTarget, candidates: string[]): number {
  if (target.type && target.type !== "page") return -1;
  if (!target.webSocketDebuggerUrl) return -1;
  const targetUrl = normalizeUrl(target.url);
  if (!targetUrl) return candidates.length === 0 ? 1 : 0;
  let best = candidates.length === 0 ? 1 : 0;
  for (const candidate of candidates.map(normalizeUrl).filter(Boolean)) {
    if (targetUrl === candidate) best = Math.max(best, 100);
    else if (targetUrl.startsWith(candidate) || candidate.startsWith(targetUrl)) best = Math.max(best, 80);
    else if (targetUrl.includes(candidate) || candidate.includes(targetUrl)) best = Math.max(best, 40);
  }
  return best;
}

export async function getAndroidWebViewCdpEndpoint(
  candidates: string[],
): Promise<AndroidWebViewCdpEndpoint> {
  if (Platform.OS !== "android") {
    throw new Error("Android WebView CDP is only available on Android");
  }
  if (!nativeProxy) {
    throw new Error("Android WebView CDP native proxy is not available");
  }

  const proxy = await nativeProxy.start();
  const host = proxy.host ?? "127.0.0.1";
  const response = await fetch(`http://${host}:${proxy.port}/json`);
  if (!response.ok) {
    throw new Error(`Android WebView CDP target discovery failed: HTTP ${response.status}`);
  }
  const targets = (await response.json()) as DevtoolsTarget[];
  const ranked = targets
    .map((target) => ({ target, score: scoreTarget(target, candidates) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);
  const selected = ranked[0]?.target;
  if (!selected?.webSocketDebuggerUrl) {
    throw new Error("No debuggable Android WebView target found");
  }

  const wsUrl = new URL(selected.webSocketDebuggerUrl);
  wsUrl.hostname = host;
  wsUrl.port = String(proxy.port);
  wsUrl.protocol = "ws:";
  return { wsEndpoint: wsUrl.toString() };
}
