import { NativeModules } from "react-native";

interface NatStackMobileHostConstants {
  firebaseConfigured?: boolean;
  getConstants?: () => { firebaseConfigured?: boolean };
}

export function isNativeFirebaseConfigured(): boolean {
  const host = NativeModules["NatStackMobileHost"] as NatStackMobileHostConstants | undefined;
  const configured = host?.firebaseConfigured ?? host?.getConstants?.()?.firebaseConfigured;
  return configured !== false;
}
