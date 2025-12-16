import { contextBridge, ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import { createPanelTransportBridge } from "./transport.js";

interface GitConfig {
  serverUrl: string;
  token: string;
  sourceRepo: string;
  branch?: string;
  commit?: string;
  tag?: string;
  resolvedRepoArgs: Record<string, unknown>;
}

interface PubSubConfig {
  serverUrl: string;
  token: string;
}

declare global {
  // Unified NatStack globals
   
  var __natstackId: string | undefined;
   
  var __natstackKind: "panel" | "worker" | undefined;
   
  var __natstackParentId: string | null | undefined;
   
  var __natstackInitialTheme: "light" | "dark" | undefined;
   
  var __natstackGitConfig: GitConfig | null | undefined;
   
  var __natstackPubSubConfig: PubSubConfig | null | undefined;
   
  var __natstackEnv: Record<string, string> | undefined;
   
  var __natstackTransport:
    | {
        send: (targetId: string, message: unknown) => Promise<void>;
        onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
      }
    | undefined;
}

const parsePanelId = (): string | null => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-panel-id="));
  return arg ? (arg.split("=")[1] ?? null) : null;
};

const parseAuthToken = (): string | undefined => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-auth-token="));
  return arg ? arg.split("=")[1] : undefined;
};

const parseTheme = (): "light" | "dark" => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-theme="));
  const theme = arg?.split("=")[1];
  return theme === "dark" ? "dark" : "light";
};

const parseEnvArg = (): Record<string, string> => {
  const arg = process.argv.find((value) => value.startsWith(PANEL_ENV_ARG_PREFIX));
  if (!arg) return {};

  const encoded = arg.slice(PANEL_ENV_ARG_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const sanitizedEntries = Object.entries(parsed ?? {}).filter(
      ([key, value]) => typeof key === "string" && typeof value === "string"
    ) as Array<[string, string]>;
    return Object.fromEntries(sanitizedEntries);
  } catch (error) {
    console.error("Failed to parse panel env payload", error);
    return {};
  }
};

const panelId = parsePanelId();
if (!panelId) {
  throw new Error("Panel ID missing from additionalArguments");
}

const syntheticEnv = parseEnvArg();
const parentId = typeof syntheticEnv["PARENT_ID"] === "string" ? syntheticEnv["PARENT_ID"] : null;
const initialTheme = parseTheme();

// Parse git config from env (passed by main process to avoid RPC during bootstrap)
const parseGitConfig = (env: Record<string, string>): GitConfig | null => {
  const configStr = env["__GIT_CONFIG"];
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as GitConfig;
  } catch {
    console.error("[Panel] Failed to parse git config from env");
    return null;
  }
};
const gitConfig = parseGitConfig(syntheticEnv);

// Parse pubsub config from env (passed by main process for real-time messaging)
const parsePubSubConfig = (env: Record<string, string>): PubSubConfig | null => {
  const configStr = env["__PUBSUB_CONFIG"];
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as PubSubConfig;
  } catch {
    console.error("[Panel] Failed to parse pubsub config from env");
    return null;
  }
};
const pubsubConfig = parsePubSubConfig(syntheticEnv);

const authToken = parseAuthToken();
if (authToken) {
  void ipcRenderer.invoke("panel-bridge:register", panelId, authToken).catch((error: unknown) => {
    console.error("Failed to register panel view", error);
  });
} else {
  console.error("No auth token found for panel", panelId);
}

// Minimal Node-ish env for libraries that expect process.env
contextBridge.exposeInMainWorld("process", { env: syntheticEnv });

// Unified NatStack globals for @natstack/runtime
const transport = createPanelTransportBridge(panelId);
contextBridge.exposeInMainWorld("__natstackId", panelId);
contextBridge.exposeInMainWorld("__natstackKind", "panel");
contextBridge.exposeInMainWorld("__natstackParentId", parentId);
contextBridge.exposeInMainWorld("__natstackInitialTheme", initialTheme);
contextBridge.exposeInMainWorld("__natstackGitConfig", gitConfig);
contextBridge.exposeInMainWorld("__natstackPubSubConfig", pubsubConfig);
contextBridge.exposeInMainWorld("__natstackEnv", syntheticEnv);
contextBridge.exposeInMainWorld("__natstackTransport", transport);

// Also set globals in preload context (useful for debugging)
globalThis.__natstackId = panelId;
globalThis.__natstackKind = "panel";
globalThis.__natstackParentId = parentId;
globalThis.__natstackInitialTheme = initialTheme;
globalThis.__natstackGitConfig = gitConfig;
globalThis.__natstackPubSubConfig = pubsubConfig;
globalThis.__natstackEnv = syntheticEnv;
globalThis.__natstackTransport = transport;

// DevTools keyboard shortcut (Cmd/Ctrl+Shift+I)
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
    event.preventDefault();
    void ipcRenderer.invoke("panel:open-devtools", panelId).catch((error) => {
      console.error("Failed to open panel devtools", error);
    });
  }
});
