import { Alert } from "react-native";
import { ensureNativeWorkspaceAppBundle } from "./appBootstrap";
import type { ShellClient } from "./shellClient";
import type { ToastInput } from "../state/toastAtoms";

export interface AppLifecyclePayload {
  type?: string;
  appId?: string;
  source?: string;
  target?: string;
  buildKey?: string | null;
  error?: string;
  canRollback?: boolean;
}

export interface AppUpdatePromptDeps {
  shellClient: ShellClient;
  pushToast: (toast: ToastInput) => void;
  prompted: Set<string>;
  selectedSource?: string | null;
  selectedAppId?: string | null;
  alert?: typeof Alert.alert;
  ensureBundle?: typeof ensureNativeWorkspaceAppBundle;
}

export function handleMobileAppLifecycleEvent(
  event: AppLifecyclePayload,
  deps: AppUpdatePromptDeps
): void {
  if (!isSelectedMobileAppEvent(event, deps)) return;
  if (event.type === "update-available") {
    promptMobileUpdate(event, deps);
    return;
  }
  if (event.type === "update-error") {
    deps.pushToast({
      title: "App update failed",
      message: event.error ?? "The previous app version is still active.",
      tone: "danger",
      durationMs: 10000,
    });
    return;
  }
  if (event.type === "rolled-back") {
    deps.pushToast({
      title: "App rolled back",
      message: `${event.appId ?? "The app"} is using the previous trusted build.`,
      tone: "success",
    });
  }
}

function isSelectedMobileAppEvent(event: AppLifecyclePayload, deps: AppUpdatePromptDeps): boolean {
  if (event.target && event.target !== "react-native") return false;
  const selectedSource = deps.selectedSource ? normalizeSource(deps.selectedSource) : null;
  if (selectedSource && event.source && normalizeSource(event.source) !== selectedSource) {
    return false;
  }
  if (deps.selectedAppId && event.appId && event.appId !== deps.selectedAppId) return false;
  return true;
}

function normalizeSource(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function promptMobileUpdate(event: AppLifecyclePayload, deps: AppUpdatePromptDeps): void {
  const appId = event.appId ?? "apps/mobile";
  const promptKey = `${appId}:${event.buildKey ?? "unknown"}`;
  if (deps.prompted.has(promptKey)) return;
  deps.prompted.add(promptKey);
  const ensureBundle = deps.ensureBundle ?? ensureNativeWorkspaceAppBundle;
  const alert = deps.alert ?? Alert.alert;
  alert("Mobile app update available", `${appId} has a new trusted bundle ready to install.`, [
    { text: "Later", style: "cancel" },
    ...(event.canRollback
      ? [
          {
            text: "Roll back",
            style: "destructive" as const,
            onPress: () => {
              void deps.shellClient.workspaces
                .rollbackApp(appId)
                .then(() => ensureBundle(event.source ?? deps.selectedSource ?? null))
                .catch((error: unknown) => {
                  deps.pushToast({
                    title: "Rollback failed",
                    message: error instanceof Error ? error.message : String(error),
                    tone: "danger",
                    durationMs: 10000,
                  });
                });
            },
          },
        ]
      : []),
    {
      text: "Install",
      onPress: () => {
        void ensureBundle(event.source ?? deps.selectedSource ?? null).catch((error: unknown) => {
          deps.pushToast({
            title: "Update failed",
            message: error instanceof Error ? error.message : String(error),
            tone: "danger",
            durationMs: 10000,
          });
        });
      },
    },
  ]);
}
