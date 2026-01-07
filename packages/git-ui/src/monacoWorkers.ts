/**
 * Monaco Editor worker configuration utilities.
 *
 * This module handles the complex task of configuring Monaco's web workers
 * across different environments (Electron, web, natstack-panel protocol).
 */

import * as monaco from "monaco-editor";

export interface MonacoWorkerConfig {
  baseUrl?: string;
  token?: string;
  getWorker?: (moduleId: string, label: string) => Worker;
  getWorkerUrl?: (moduleId: string, label: string) => string;
  disableFallback?: boolean;
}

const workerFileForLabel = (label: string) => {
  if (label === "json") return "json.worker.js";
  if (label === "css" || label === "scss" || label === "less") return "css.worker.js";
  if (label === "html" || label === "handlebars" || label === "razor") return "html.worker.js";
  if (label === "typescript" || label === "javascript") return "ts.worker.js";
  return "editor.worker.js";
};

const ensureTrailingSlash = (value: string) => (value.endsWith("/") ? value : `${value}/`);

const logMonacoDebug = (message: string, ...args: unknown[]) => {
  if (process.env["NODE_ENV"] === "development") {
    console.debug("[monaco-workers]", message, ...args);
  }
};

const toAbsoluteUrl = (value: string) => {
  try {
    if (typeof document !== "undefined" && document.baseURI) {
      return new URL(value, document.baseURI).toString();
    }
    if (typeof location !== "undefined" && location.href) {
      return new URL(value, location.href).toString();
    }
  } catch {
    return value;
  }
  return value;
};

const resolveWorkerUrl = (baseUrl: string, label: string) => {
  const workerFile = workerFileForLabel(label);
  let url: string;
  try {
    url = new URL(workerFile, baseUrl).toString();
  } catch {
    url = `${ensureTrailingSlash(baseUrl)}${workerFile}`;
  }
  logMonacoDebug(`Resolved worker URL for "${label}":`, url);
  return url;
};

const appendToken = (url: string, token: string | undefined) => {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
};

const createWorkerFromUrl = (url: string, label: string) => {
  if (typeof Worker === "undefined") {
    throw new Error("Web Workers are unavailable in this environment.");
  }
  try {
    return new Worker(url, { type: "module", name: label });
  } catch {
    return new Worker(url, { name: label });
  }
};

const createNoopWorker = (label: string) => {
  if (typeof Worker === "undefined") {
    throw new Error("Web Workers are unavailable in this environment.");
  }
  const source = "self.onmessage = () => {};";
  if (typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { name: label });
    URL.revokeObjectURL(url);
    return worker;
  }
  const dataUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  return new Worker(dataUrl, { name: label });
};

const disableLanguageServices = () => {
  // Access typescript namespace - Monaco's types are complex, use bracket notation
  const monacoAny = monaco as Record<string, unknown>;
  const typescript = monacoAny["typescript"] as {
    typescriptDefaults?: {
      setDiagnosticsOptions: (options: Record<string, boolean>) => void;
      setModeConfiguration: (config: Record<string, boolean>) => void;
    };
    javascriptDefaults?: {
      setDiagnosticsOptions: (options: Record<string, boolean>) => void;
      setModeConfiguration: (config: Record<string, boolean>) => void;
    };
  } | undefined;

  if (!typescript) return;

  const modeConfiguration = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  };

  const diagnosticsOptions = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  };

  typescript.typescriptDefaults?.setDiagnosticsOptions(diagnosticsOptions);
  typescript.typescriptDefaults?.setModeConfiguration(modeConfiguration);
  typescript.javascriptDefaults?.setDiagnosticsOptions(diagnosticsOptions);
  typescript.javascriptDefaults?.setModeConfiguration(modeConfiguration);
};

/**
 * Get worker configuration, trying in order:
 * 1. Explicit global config (__MONACO_WORKER_CONFIG__)
 * 2. Explicit global base URL (__MONACO_WORKER_BASE_URL__)
 * 3. Auto-detect from location.href (works in both main renderer and panels)
 */
const getWorkerConfig = (): MonacoWorkerConfig | null => {
  const globalAny = globalThis as typeof globalThis & {
    __MONACO_WORKER_CONFIG__?: MonacoWorkerConfig;
    __MONACO_WORKER_BASE_URL__?: string;
    __MONACO_WORKER_TOKEN__?: string;
  };

  // 1. Explicit full config takes precedence
  if (globalAny.__MONACO_WORKER_CONFIG__) {
    logMonacoDebug("Found explicit __MONACO_WORKER_CONFIG__", globalAny.__MONACO_WORKER_CONFIG__);
    return globalAny.__MONACO_WORKER_CONFIG__;
  }

  // 2. Explicit base URL
  if (globalAny.__MONACO_WORKER_BASE_URL__) {
    logMonacoDebug("Found __MONACO_WORKER_BASE_URL__:", globalAny.__MONACO_WORKER_BASE_URL__);
    return {
      baseUrl: globalAny.__MONACO_WORKER_BASE_URL__,
      token: globalAny.__MONACO_WORKER_TOKEN__,
    };
  }

  // 3. Auto-detect from location - works in main renderer and panels
  if (typeof location !== "undefined" && location.href) {
    try {
      const baseUrl = new URL("monaco/", location.href).toString();
      logMonacoDebug("Auto-detected baseUrl from location:", baseUrl);
      return { baseUrl };
    } catch {
      logMonacoDebug("Failed to construct URL from location.href:", location.href);
    }
  }

  logMonacoDebug("No worker config found");
  return null;
};


const applyMonacoEnvironment = (config: MonacoWorkerConfig) => {
  const globalAny = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker?: (moduleId: string, label: string) => Worker;
      getWorkerUrl?: (moduleId: string, label: string) => string;
    };
  };

  const baseUrl = config.baseUrl ? toAbsoluteUrl(ensureTrailingSlash(config.baseUrl)) : null;
  const getWorker =
    config.getWorker ??
    (baseUrl
      ? (moduleId: string, label: string) => {
          const workerUrl = appendToken(resolveWorkerUrl(baseUrl, label), config.token);
          return createWorkerFromUrl(workerUrl, label);
        }
      : undefined);

  const getWorkerUrl =
    config.getWorkerUrl ??
    (baseUrl
      ? (moduleId: string, label: string) => {
          return appendToken(resolveWorkerUrl(baseUrl, label), config.token);
        }
      : undefined);

  const existing = globalAny.MonacoEnvironment ?? {};
  globalAny.MonacoEnvironment = {
    ...existing,
    ...(getWorker ? { getWorker } : {}),
    ...(getWorkerUrl ? { getWorkerUrl } : {}),
  };
};

let warnedFallback = false;
let loggedMonacoConfig = false;

const canUseDefaultWorkers = () => {
  if (typeof Worker === "undefined") return false;
  try {
    void new URL("monaco-worker.js", import.meta.url);
    return true;
  } catch {
    return false;
  }
};

const logMonacoConfig = (message: string) => {
  if (loggedMonacoConfig || typeof console === "undefined") return;
  loggedMonacoConfig = true;
  console.info(message);
};

/**
 * Configure Monaco editor web workers.
 *
 * This function attempts to configure workers in the following order:
 * 1. Explicit config passed as argument
 * 2. Global config (__MONACO_WORKER_CONFIG__ or __MONACO_WORKER_BASE_URL__)
 * 3. Auto-detected from location.href (works in main renderer and panels)
 * 4. Default workers using import.meta.url
 * 5. Fallback to noop workers with disabled language services
 *
 * In most cases, no configuration is needed - workers are auto-detected
 * from the current location, which works in both environments.
 */
export const configureMonacoWorkers = (config?: MonacoWorkerConfig) => {
  logMonacoDebug("configureMonacoWorkers called", config ? "with explicit config" : "without config");

  const globalAny = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker?: (moduleId: string, label: string) => Worker;
      getWorkerUrl?: (moduleId: string, label: string) => string;
    };
  };
  let resolvedConfig = config;
  let configSource: "explicit" | "auto" | null = null;
  if (resolvedConfig) {
    configSource = "explicit";
    logMonacoDebug("Using explicit config");
  } else {
    const autoConfig = getWorkerConfig();
    if (autoConfig) {
      resolvedConfig = autoConfig;
      configSource = "auto";
      logMonacoDebug("Using auto-detected config");
    }
  }

  if (!config && (globalAny.MonacoEnvironment?.getWorker || globalAny.MonacoEnvironment?.getWorkerUrl)) {
    logMonacoDebug("Skipping configuration - MonacoEnvironment already exists");
    return;
  }

  if (resolvedConfig && (resolvedConfig.getWorker || resolvedConfig.getWorkerUrl || resolvedConfig.baseUrl)) {
    applyMonacoEnvironment(resolvedConfig);
    const baseUrl = resolvedConfig.baseUrl ? toAbsoluteUrl(ensureTrailingSlash(resolvedConfig.baseUrl)) : null;
    const resolver = resolvedConfig.getWorker || resolvedConfig.getWorkerUrl ? "custom" : "default";
    const tokenState = resolvedConfig.token ? "present" : "absent";
    logMonacoConfig(
      `Monaco workers configured (${configSource ?? "unknown"}): ${resolver}${baseUrl ? ` ${baseUrl}` : ""} token=${tokenState}.`
    );
    return;
  }

  if (config?.disableFallback) {
    logMonacoDebug("Fallback disabled by config");
    return;
  }

  if (canUseDefaultWorkers()) {
    logMonacoDebug("Using default workers via import.meta.url");
    logMonacoConfig("Monaco workers configured (default): import.meta.url resolved.");
    return;
  }

  logMonacoDebug("No worker config available - falling back to noop workers");
  disableLanguageServices();
  try {
    applyMonacoEnvironment({
      getWorker: (_moduleId, label) => createNoopWorker(label),
    });
    logMonacoDebug("Noop workers applied successfully");
  } catch (err) {
    logMonacoDebug("Failed to apply noop workers:", err);
  }

  if (!warnedFallback && typeof console !== "undefined") {
    warnedFallback = true;
    console.warn(
      "Monaco workers are not configured; language services are disabled. " +
        "Set globalThis.__MONACO_WORKER_BASE_URL__ or call configureMonacoWorkers()."
    );
  }
};
