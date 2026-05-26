import { Platform } from "react-native";
import { hasApprovedAppCapability, setApprovedAppCapabilities } from "./appCapabilities";
import { activatePreparedAppBundle, prepareAppBundle } from "./auth";
import { registerBackgroundHandlers } from "./backgroundHandlers";

const RN_HOST_ABI = "rn-host-1";

export async function ensureNativeWorkspaceAppBundle(
  source?: string | null
): Promise<{ reloading: boolean }> {
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const prepared = await prepareAppBundle(RN_HOST_ABI, platform, source);
  setApprovedAppCapabilities(prepared.capabilities);
  if (hasApprovedAppCapability("notifications")) {
    registerBackgroundHandlers();
  }
  const activated = await activatePreparedAppBundle(prepared);
  return { reloading: activated.activated };
}
