/**
 * Shared validator for the `natstack.*` section of an extension's
 * `package.json`. Used at three points:
 *
 *   1. Build (`buildExtension` in `src/server/buildV2/builder.ts`) — refuse
 *      to produce a bundle for a malformed manifest.
 *   2. Install (`ExtensionHost.install`) — refuse to record an extension
 *      registry entry that wouldn't build.
 *   3. Boot (`ExtensionHost.startEnabled`) — refuse to launch a previously
 *      installed extension whose manifest has since drifted out of spec.
 *
 * The spec (EXTENSIONS.md §Manifest) explicitly requires fail-closed
 * validation at install and boot; centralising the schema here ensures
 * the three call sites can't drift.
 *
 * Throws `ExtensionManifestError` on any violation, with a `code` field
 * suitable for surfacing in `RegistryEntry.lastError`.
 */

export class ExtensionManifestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ExtensionManifestError";
    this.code = code;
  }
}

export interface ExtensionManifestValidationOptions {
  /** Display name used in error messages (typically the package name). */
  unitName: string;
}

/**
 * Validate the parsed `natstack` block from an extension's `package.json`.
 * Pass the raw object — this function does the shape checks itself.
 *
 * Rules in v1:
 *   - Exactly one kind block, and it must be `extension`.
 *   - `sourcemap`, if present, must not be `false` (extensions ship inline maps).
 *   - `extension.activationEvents`, if present, must be `["*"]`.
 *   - `extension.dependencyMode`, if present, must be "auto" / "bundle" / "external".
 */
export function validateExtensionManifestBlock(
  manifest: unknown,
  options: ExtensionManifestValidationOptions,
): void {
  if (!manifest || typeof manifest !== "object") {
    throw new ExtensionManifestError(
      `Extension ${options.unitName} is missing the natstack manifest block`,
      "MANIFEST_MISSING",
    );
  }
  const record = manifest as Record<string, unknown>;
  const kindBlocks = ["extension", "worker", "panel"].filter((key) => {
    const value = record[key];
    return value !== undefined && value !== null;
  });
  if (kindBlocks.length !== 1 || kindBlocks[0] !== "extension") {
    throw new ExtensionManifestError(
      `Extension ${options.unitName} must declare exactly one kind block: natstack.extension (found: ${
        kindBlocks.length === 0 ? "none" : kindBlocks.join(", ")
      })`,
      "MANIFEST_KIND",
    );
  }
  if (record["sourcemap"] === false) {
    throw new ExtensionManifestError(
      `Extension ${options.unitName} must use inline sourcemaps in v1`,
      "MANIFEST_SOURCEMAP",
    );
  }

  const extension = record["extension"] as {
    activationEvents?: unknown;
    dependencyMode?: unknown;
  } | undefined;
  const events = extension?.activationEvents;
  if (events !== undefined) {
    if (!Array.isArray(events) || events.some((event) => event !== "*")) {
      throw new ExtensionManifestError(
        `Extension ${options.unitName} only supports activationEvents: ["*"] in v1`,
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
    throw new ExtensionManifestError(
      `Extension ${options.unitName} dependencyMode must be "auto", "bundle", or "external"`,
      "MANIFEST_DEPENDENCY_MODE",
    );
  }
}

/**
 * Read and validate the `natstack` block from a `package.json` on disk.
 * Returns the validated block. Throws `ExtensionManifestError` on any
 * filesystem or schema failure.
 */
export function readAndValidateExtensionManifest(
  packageJsonPath: string,
  options: ExtensionManifestValidationOptions,
  readFileSync: (p: string, encoding: "utf-8") => string,
): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf-8");
  } catch (err) {
    throw new ExtensionManifestError(
      `Extension ${options.unitName} package.json not readable at ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MANIFEST_READ",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ExtensionManifestError(
      `Extension ${options.unitName} package.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "MANIFEST_PARSE",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ExtensionManifestError(
      `Extension ${options.unitName} package.json must be a JSON object`,
      "MANIFEST_PARSE",
    );
  }
  const natstack = (parsed as { natstack?: unknown }).natstack;
  validateExtensionManifestBlock(natstack ?? {}, options);
  return (natstack as Record<string, unknown>) ?? {};
}
