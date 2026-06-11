/**
 * Shared validator for declarative trusted workspace-unit manifests.
 *
 * Extensions and apps are both build-gated, approval-gated workspace units.
 * This module keeps their fail-closed package.json validation in one place so
 * build, reconcile/install, and boot checks cannot drift by unit kind.
 */

export type UnitKind = "extension" | "app";
export type WorkspaceAppTarget = "electron" | "react-native" | "terminal";

/**
 * Optional worker manifest fields for terminal-renderable workers.
 *
 * Workers are not centrally validated (their manifests are read ad-hoc by the
 * builder), so these are lightweight typed shapes + predicates shared by the
 * build pipeline (`buildWorker`) and the workerd config generator
 * (`workerdManager`). A terminal worker renders with Ink inside workerd; the
 * build aliases `yoga-layout` to the terminal-shim loader and emits a
 * `yoga.wasm` artifact, and workerd is given that wasm as a module binding.
 */
export interface WorkerTerminalConfig {
  /** Only "ink" is supported for now. */
  renderer: "ink";
  /** Optional default viewport hint (host is authoritative at runtime). */
  viewport?: { columns: number; rows: number };
}

/** Read the `natstack.terminal` block from a worker manifest, if present. */
export function workerTerminalConfig(
  natstack: Record<string, unknown> | undefined | null,
): WorkerTerminalConfig | null {
  const terminal = natstack?.["terminal"];
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) return null;
  const renderer = (terminal as Record<string, unknown>)["renderer"];
  if (renderer !== "ink") return null;
  return terminal as WorkerTerminalConfig;
}

/** A worker whose `natstack.terminal.renderer` is "ink" renders inside workerd via Ink. */
export function isTerminalWorker(
  natstack: Record<string, unknown> | undefined | null,
): boolean {
  return workerTerminalConfig(natstack) !== null;
}

/**
 * A persistent (resident, non-hibernating) worker. NatStack runs workerd
 * locally, so keeping a DO resident costs only host memory — used by terminal
 * session workers that hold a live Ink render tree that cannot be cheaply
 * rebuilt on every hibernation.
 */
export function isPersistentWorker(
  natstack: Record<string, unknown> | undefined | null,
): boolean {
  return natstack?.["persistent"] === true;
}

export const APP_CAPABILITIES_BY_TARGET = {
  electron: [
    "native-menus",
    "notifications",
    "tray",
    "global-shortcut",
    "fs-read",
    "fs-write",
    "clipboard",
    "dialog",
    "open-external",
    "window-management",
    "panel-hosting",
    "incoming-pair-links",
    "connection-management",
  ],
  "react-native": [
    "notifications",
    "camera",
    "keychain",
    "fs-read",
    "fs-write",
    "clipboard",
    "open-external",
    "panel-hosting",
    "connection-management",
  ],
  terminal: [
    "clipboard",
    "open-external",
    "connection-management",
  ],
} as const satisfies Record<WorkspaceAppTarget, readonly string[]>;

export type AppCapability =
  typeof APP_CAPABILITIES_BY_TARGET[keyof typeof APP_CAPABILITIES_BY_TARGET][number];

export class UnitManifestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "UnitManifestError";
    this.code = code;
  }
}

export interface UnitManifestValidationOptions {
  /** Display name used in error messages, typically the package name. */
  unitName: string;
}

export interface UnitManifestDescriptor {
  kind: UnitKind;
  label: string;
}

export const extensionUnitManifestDescriptor: UnitManifestDescriptor = {
  kind: "extension",
  label: "Extension",
};

export const appUnitManifestDescriptor: UnitManifestDescriptor = {
  kind: "app",
  label: "App",
};

const KIND_BLOCKS = ["extension", "worker", "panel", "app"] as const;

function assertRecord(value: unknown, label: string, options: UnitManifestValidationOptions): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnitManifestError(
      `${label} ${options.unitName} is missing the natstack manifest block`,
      "MANIFEST_MISSING",
    );
  }
  return value as Record<string, unknown>;
}

function assertOptionalString(
  value: unknown,
  message: string,
  code: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnitManifestError(message, code);
  }
  return value;
}

function assertNoForeignKindBlocks(
  record: Record<string, unknown>,
  descriptor: UnitManifestDescriptor,
  options: UnitManifestValidationOptions,
): void {
  const kindBlocks = KIND_BLOCKS.filter((key) => record[key] !== undefined && record[key] !== null);
  if (kindBlocks.length !== 1 || kindBlocks[0] !== descriptor.kind) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} must declare exactly one kind block: natstack.${descriptor.kind} (found: ${
        kindBlocks.length === 0 ? "none" : kindBlocks.join(", ")
      })`,
      "MANIFEST_KIND",
    );
  }
}

function validateInlineSourcemap(
  record: Record<string, unknown>,
  descriptor: UnitManifestDescriptor,
  options: UnitManifestValidationOptions,
): void {
  if (record["sourcemap"] === false) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} must use inline sourcemaps`,
      "MANIFEST_SOURCEMAP",
    );
  }
}

function validateExtensionBlock(
  record: Record<string, unknown>,
  options: UnitManifestValidationOptions,
): void {
  const extension = record["extension"] as {
    activationEvents?: unknown;
    dependencyMode?: unknown;
    streamingMethods?: unknown;
    contributes?: unknown;
  } | undefined;

  const events = extension?.activationEvents;
  if (events !== undefined) {
    if (!Array.isArray(events) || events.some((event) => event !== "*")) {
      throw new UnitManifestError(
        `Extension ${options.unitName} only supports activationEvents: ["*"]`,
        "MANIFEST_ACTIVATION",
      );
    }
  }

  const dependencyMode = extension?.dependencyMode;
  if (
    dependencyMode !== undefined
    && dependencyMode !== "auto"
    && dependencyMode !== "bundle"
    && dependencyMode !== "external"
  ) {
    throw new UnitManifestError(
      `Extension ${options.unitName} dependencyMode must be "auto", "bundle", or "external"`,
      "MANIFEST_DEPENDENCY_MODE",
    );
  }

  const streamingMethods = extension?.streamingMethods;
  if (
    streamingMethods !== undefined
    && (!Array.isArray(streamingMethods) || streamingMethods.some((method) => typeof method !== "string"))
  ) {
    throw new UnitManifestError(
      `Extension ${options.unitName} streamingMethods must be an array of method names`,
      "MANIFEST_STREAMING_METHODS",
    );
  }

  const contributes = extension?.contributes;
  if (contributes !== undefined) {
    if (!contributes || typeof contributes !== "object" || Array.isArray(contributes)) {
      throw new UnitManifestError(
        `Extension ${options.unitName} contributes must be an object`,
        "MANIFEST_CONTRIBUTES",
      );
    }
    const buildTargets = (contributes as Record<string, unknown>)["buildTargets"];
    if (
      buildTargets !== undefined
      && (!Array.isArray(buildTargets) || buildTargets.some((target) => target !== "react-native"))
    ) {
      throw new UnitManifestError(
        `Extension ${options.unitName} contributes.buildTargets may only include "react-native"`,
        "MANIFEST_BUILD_TARGETS",
      );
    }
  }
}

function validateAppBlock(
  record: Record<string, unknown>,
  options: UnitManifestValidationOptions,
): void {
  const app = record["app"];
  if (!app || typeof app !== "object" || Array.isArray(app)) {
    throw new UnitManifestError(
      `App ${options.unitName} natstack.app must be an object`,
      "MANIFEST_APP_BLOCK",
    );
  }
  const appRecord = app as Record<string, unknown>;

  const target = appRecord["target"];
  if (target !== "electron" && target !== "react-native" && target !== "terminal") {
    throw new UnitManifestError(
      `App ${options.unitName} target must be "electron", "react-native", or "terminal"`,
      "MANIFEST_APP_TARGET",
    );
  }

  assertOptionalString(
    appRecord["displayName"],
    `App ${options.unitName} displayName must be a non-empty string when provided`,
    "MANIFEST_APP_DISPLAY_NAME",
  );
  const entryField = target === "terminal" ? "entry" : "renderer";
  if (typeof appRecord[entryField] !== "string" || appRecord[entryField].trim().length === 0) {
    throw new UnitManifestError(
      `App ${options.unitName} ${entryField} must be a non-empty string`,
      "MANIFEST_APP_RENDERER",
    );
  }
  if (target === "terminal" && appRecord["renderer"] !== undefined) {
    throw new UnitManifestError(
      `Terminal app ${options.unitName} must use natstack.app.entry instead of renderer`,
      "MANIFEST_APP_TERMINAL_RENDERER",
    );
  }
  if (target !== "terminal" && appRecord["entry"] !== undefined) {
    throw new UnitManifestError(
      `App ${options.unitName} natstack.app.entry is only supported for terminal apps`,
      "MANIFEST_APP_TERMINAL_ENTRY",
    );
  }

  // Interactive (TUI) terminal apps get the real TTY (stdio inherit) at launch.
  if (appRecord["interactive"] !== undefined) {
    if (typeof appRecord["interactive"] !== "boolean") {
      throw new UnitManifestError(
        `App ${options.unitName} natstack.app.interactive must be a boolean`,
        "MANIFEST_APP_INTERACTIVE",
      );
    }
    if (target !== "terminal" && appRecord["interactive"] === true) {
      throw new UnitManifestError(
        `App ${options.unitName} natstack.app.interactive is only supported for terminal apps`,
        "MANIFEST_APP_INTERACTIVE_TARGET",
      );
    }
  }

  for (const forbidden of ["main", "preload", "window"]) {
    if (appRecord[forbidden] !== undefined) {
      throw new UnitManifestError(
        `App ${options.unitName} is pure-thin and must not declare natstack.app.${forbidden}`,
        "MANIFEST_APP_NATIVE_FIELD",
      );
    }
  }

  const capabilities = appRecord["capabilities"];
  if (capabilities !== undefined) {
    const allowed = new Set<string>(APP_CAPABILITIES_BY_TARGET[target]);
    if (
      !Array.isArray(capabilities)
      || capabilities.some((capability) => typeof capability !== "string" || !allowed.has(capability))
    ) {
      throw new UnitManifestError(
        `App ${options.unitName} capabilities must be known ${target} capabilities`,
        "MANIFEST_APP_CAPABILITIES",
      );
    }
  }

  if (target === "react-native") {
    assertOptionalString(
      appRecord["rnComponentName"],
      `React Native app ${options.unitName} rnComponentName must be a non-empty string`,
      "MANIFEST_APP_RN_COMPONENT",
    );
    assertOptionalString(
      appRecord["rnHostAbi"],
      `React Native app ${options.unitName} rnHostAbi must be a non-empty string`,
      "MANIFEST_APP_RN_ABI",
    );
    if (typeof appRecord["rnComponentName"] !== "string" || typeof appRecord["rnHostAbi"] !== "string") {
      throw new UnitManifestError(
        `React Native app ${options.unitName} requires rnComponentName and rnHostAbi`,
        "MANIFEST_APP_RN_REQUIRED",
      );
    }
  } else if (appRecord["rnComponentName"] !== undefined || appRecord["rnHostAbi"] !== undefined) {
    throw new UnitManifestError(
      `${target === "terminal" ? "Terminal" : "Electron"} app ${options.unitName} must not declare React Native-only fields`,
      "MANIFEST_APP_RN_FIELD",
    );
  }
}

/**
 * Validate a parsed `natstack` block from a package.json.
 */
export function validateUnitManifest(
  descriptor: UnitManifestDescriptor,
  manifest: unknown,
  options: UnitManifestValidationOptions,
): void {
  const record = assertRecord(manifest, descriptor.label, options);
  assertNoForeignKindBlocks(record, descriptor, options);
  validateInlineSourcemap(record, descriptor, options);

  if (descriptor.kind === "extension") {
    validateExtensionBlock(record, options);
  } else {
    validateAppBlock(record, options);
  }
}

/**
 * Read and validate the `natstack` block from a package.json on disk.
 */
export function readAndValidateUnitManifest(
  descriptor: UnitManifestDescriptor,
  packageJsonPath: string,
  options: UnitManifestValidationOptions,
  readFileSync: (p: string, encoding: "utf-8") => string,
): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf-8");
  } catch (err) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} package.json not readable at ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MANIFEST_READ",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} package.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MANIFEST_PARSE",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnitManifestError(
      `${descriptor.label} ${options.unitName} package.json must be a JSON object`,
      "MANIFEST_PARSE",
    );
  }

  const natstack = (parsed as { natstack?: unknown }).natstack;
  validateUnitManifest(descriptor, natstack ?? {}, options);
  return (natstack as Record<string, unknown>) ?? {};
}
