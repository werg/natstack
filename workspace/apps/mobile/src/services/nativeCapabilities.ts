import { Linking } from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";
import { requireApprovedAppCapability } from "./appCapabilities";

export function copyToClipboard(value: string): void {
  requireApprovedAppCapability("clipboard", "clipboard write");
  Clipboard.setString(value);
}

export async function openExternalUrl(url: string): Promise<void> {
  requireApprovedAppCapability("open-external", "external URL open");
  await Linking.openURL(url);
}
