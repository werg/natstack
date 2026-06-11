import AsyncStorage from "@react-native-async-storage/async-storage";

const CONSUMED_CONNECT_LINK_KEY = "natstack:connect:consumed-url";
const CONSUMED_CONNECT_LINK_TTL_MS = 10 * 60 * 1000;

interface ConsumedConnectLink {
  url: string;
  consumedAt: number;
}

export async function markConnectLinkConsumed(rawUrl: string, now = Date.now()): Promise<void> {
  if (!isConnectLink(rawUrl)) return;
  await AsyncStorage.setItem(
    CONSUMED_CONNECT_LINK_KEY,
    JSON.stringify({ url: rawUrl, consumedAt: now } satisfies ConsumedConnectLink)
  );
}

export async function consumeConnectLinkReplay(rawUrl: string, now = Date.now()): Promise<boolean> {
  if (!isConnectLink(rawUrl)) return false;

  const stored = parseConsumedConnectLink(await AsyncStorage.getItem(CONSUMED_CONNECT_LINK_KEY));
  if (!stored) return false;

  const age = now - stored.consumedAt;
  const sameUrl = stored.url === rawUrl;
  const stale = age < 0 || age > CONSUMED_CONNECT_LINK_TTL_MS;
  if (stale) {
    await AsyncStorage.removeItem(CONSUMED_CONNECT_LINK_KEY);
  }
  return sameUrl && !stale;
}

export function isConnectLinkForStoredServer(
  linkServerUrl: string,
  storedServerUrl: string | null | undefined
): boolean {
  return !!storedServerUrl && linkServerUrl === storedServerUrl;
}

function isConnectLink(rawUrl: string): boolean {
  return rawUrl.startsWith("natstack://connect");
}

function parseConsumedConnectLink(raw: string | null): ConsumedConnectLink | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConsumedConnectLink>;
    if (typeof parsed.url !== "string" || typeof parsed.consumedAt !== "number") return null;
    return { url: parsed.url, consumedAt: parsed.consumedAt };
  } catch {
    return null;
  }
}
