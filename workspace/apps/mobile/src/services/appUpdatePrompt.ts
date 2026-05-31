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
  effectiveVersion?: string | null;
  previousBuildKey?: string | null;
  previousEffectiveVersion?: string | null;
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

/**
 * Build a version-aware update message. Surfaces the target version (and the
 * version being replaced, when both are known) so the prompt isn't blind about
 * what it's installing; falls back to generic copy when the server didn't
 * report versions.
 */
function formatUpdateMessage(event: AppLifecyclePayload, appId: string): string {
  const next = event.effectiveVersion?.trim();
  const prev = event.previousEffectiveVersion?.trim();
  if (next && prev && next !== prev) {
    return `${appId} v${prev} → v${next} is ready to install.`;
  }
  if (next) {
    return `${appId} v${next} is ready to install.`;
  }
  return `${appId} has a new trusted bundle ready to install.`;
}

function promptMobileUpdate(event: AppLifecyclePayload, deps: AppUpdatePromptDeps): void {
  const appId = event.appId ?? "apps/mobile";
  // Version awareness: ignore no-op events where the "new" build is the one
  // already running -- e.g. a lifecycle event re-emitted (on reconnect) for a
  // build the user already installed. The server reports the build being
  // replaced as previousBuildKey.
  if (event.buildKey && event.previousBuildKey && event.buildKey === event.previousBuildKey) {
    return;
  }
  const promptKey = `${appId}:${event.buildKey ?? "unknown"}`;
  if (deps.prompted.has(promptKey)) return;
  deps.prompted.add(promptKey);
  const ensureBundle = deps.ensureBundle ?? ensureNativeWorkspaceAppBundle;
  const alert = deps.alert ?? Alert.alert;
  alert("Mobile app update available", formatUpdateMessage(event, appId), [
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
