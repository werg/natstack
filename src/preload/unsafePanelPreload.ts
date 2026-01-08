import { ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import { createPanelTransportBridge } from "./transport.js";

/**
 * Unsafe panel preload script for panels with nodeIntegration enabled.
 *
 * This preload runs with:
 * - nodeIntegration: true (full Node.js APIs available)
 * - contextIsolation: false (preload and renderer share global context)
 * - sandbox: false (no process/filesystem restrictions)
 *
 * The renderer has direct access to require(), fs, process, and all Node.js modules.
 */

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
  // Only declare __natstackTransport here - other globals are declared in @natstack/runtime
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

const parseScopePath = (): string | null => {
  const arg = process.argv.find((value) => value.startsWith("--natstack-scope-path="));
  return arg ? (arg.split("=")[1] ?? null) : null;
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
const scopePath = parseScopePath();

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

// Create transport bridge
const transport = createPanelTransportBridge(panelId);

// Since contextIsolation is false, set globals directly on globalThis
// The renderer has direct access to these (no contextBridge needed)
globalThis.__natstackId = panelId;
globalThis.__natstackKind = "panel";
globalThis.__natstackParentId = parentId;
globalThis.__natstackInitialTheme = initialTheme;
globalThis.__natstackGitConfig = gitConfig as unknown as typeof globalThis.__natstackGitConfig;
globalThis.__natstackPubSubConfig = pubsubConfig as unknown as typeof globalThis.__natstackPubSubConfig;
globalThis.__natstackEnv = syntheticEnv;
globalThis.__natstackTransport = transport;

// Set filesystem scope root for unsafe panels
// Panel code can check this to voluntarily respect scoping, but it's not enforced
if (scopePath) {
  Object.defineProperty(globalThis, "__natstackFsRoot", {
    value: scopePath,
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

// Merge synthetic env with real process.env
// This allows panels to access both NatStack env vars and system env vars
Object.assign(process.env, syntheticEnv);

// DevTools keyboard shortcut (Cmd/Ctrl+Shift+I)
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
    event.preventDefault();
    void ipcRenderer.invoke("panel:open-devtools", panelId).catch((error) => {
      console.error("Failed to open panel devtools", error);
    });
  }
});
