import { buildMethods, type LibraryBuildTarget } from "./serviceSchemas/build.js";
import {
  createTypedServiceClient,
  type ServiceCallFn,
  type TypedServiceClient,
} from "./typedServiceClient.js";

export type BuildServiceClient = TypedServiceClient<typeof buildMethods>;
export type EvalImportLoader = (
  specifier: string,
  ref: string | undefined,
  externals: string[]
) => Promise<string>;

export function createBuildServiceClient(call: ServiceCallFn): BuildServiceClient {
  return createTypedServiceClient("build", buildMethods, call);
}

export function requireBuildBundleResult(result: unknown, message: string): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "bundle" in result &&
    typeof result.bundle === "string"
  ) {
    return result.bundle;
  }
  throw new Error(message);
}

function parsePackageQualifiedNpmRef(value: string): { specifier: string; version: string } | null {
  const at = value.lastIndexOf("@");
  if (at <= 0) return null;
  const specifier = value.slice(0, at);
  if (!specifier.includes("/") && specifier.startsWith("@")) return null;
  return { specifier, version: value.slice(at + 1) || "latest" };
}

function npmRefToVersion(specifier: string, ref: string): string {
  const value = ref.slice("npm:".length) || "latest";
  const qualified = parsePackageQualifiedNpmRef(value);
  if (!qualified) return value;
  if (qualified.specifier !== specifier) {
    throw new Error(
      `npm import ${JSON.stringify(specifier)} points at ${JSON.stringify(qualified.specifier)}. ` +
        `The imports map key is the package name; use ` +
        `imports: { ${JSON.stringify(qualified.specifier)}: ${JSON.stringify(`npm:${qualified.version}`)} } instead.`
    );
  }
  return qualified.version;
}

/**
 * Build the on-demand import loader for a sandbox host. `target` selects the
 * module resolution conditions for workspace library bundles and MUST match the
 * host's execution environment — `worker` for the eval sandbox (a workerd DO),
 * `panel` for a panel-hosted sandbox. No default: pick deliberately.
 */
export function createEvalImportLoader(
  build: BuildServiceClient,
  target: LibraryBuildTarget
): EvalImportLoader {
  return async (specifier, ref, externals) => {
    if (ref?.startsWith("npm:")) {
      const version = npmRefToVersion(specifier, ref);
      const result = await build.getBuildNpm(specifier, version, externals);
      return result.bundle;
    }

    const result = await build.getBuild(specifier, ref, {
      library: true,
      externals,
      libraryTarget: target,
    });
    return requireBuildBundleResult(
      result,
      `Build service returned a full build for library import: ${specifier}`
    );
  };
}
