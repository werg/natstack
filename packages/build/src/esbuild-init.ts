/**
 * Shared esbuild-wasm Initialization
 *
 * Provides a single initialization point for esbuild-wasm to prevent
 * the "esbuild already initialized" error when multiple modules try to init.
 *
 * State is stored in globalThis to ensure a single instance across the entire
 * application, even if this module is loaded multiple times (e.g., in HMR scenarios).
 */

type EsbuildWasm = typeof import("esbuild-wasm");

interface EsbuildGlobalState {
  esbuild: EsbuildWasm | null;
  initPromise: Promise<EsbuildWasm> | null;
  initialized: boolean;
}

// Use globalThis to ensure single instance across entire application
const GLOBAL_KEY = "__natstack_build_esbuild__" as const;

function getGlobalState(): EsbuildGlobalState {
  if (!(GLOBAL_KEY in globalThis)) {
    (globalThis as unknown as Record<string, EsbuildGlobalState>)[GLOBAL_KEY] = {
      esbuild: null,
      initPromise: null,
      initialized: false,
    };
  }
  return (globalThis as unknown as Record<string, EsbuildGlobalState>)[GLOBAL_KEY]!;
}

export interface EsbuildInitOptions {
  /** URL to the esbuild.wasm file */
  wasmURL?: string;
}

/**
 * Get the shared esbuild instance, initializing if needed.
 * Safe to call multiple times - will only initialize once.
 *
 * @param options - Initialization options (only used on first call)
 * @returns The initialized esbuild module
 */
export function getEsbuild(
  options: EsbuildInitOptions = {}
): Promise<EsbuildWasm> {
  const state = getGlobalState();

  if (state.initPromise) {
    return state.initPromise;
  }

  state.initPromise = doInitialize(options);
  return state.initPromise;
}

/**
 * Check if esbuild is initialized and available.
 */
export function isEsbuildAvailable(): boolean {
  const state = getGlobalState();
  return state.initialized && state.esbuild !== null;
}

/**
 * Get the esbuild instance if already initialized, or null.
 */
export function getEsbuildSync(): EsbuildWasm | null {
  const state = getGlobalState();
  return state.initialized ? state.esbuild : null;
}

async function doInitialize(options: EsbuildInitOptions): Promise<EsbuildWasm> {
  const state = getGlobalState();

  try {
    state.esbuild = await import("esbuild-wasm");

    const version = state.esbuild.version;
    const wasmURL =
      options.wasmURL || `https://unpkg.com/esbuild-wasm@${version}/esbuild.wasm`;

    await state.esbuild.initialize({
      wasmURL,
      worker: true,
    });

    state.initialized = true;
    return state.esbuild;
  } catch (error) {
    // Reset all state on failure to allow retry
    state.esbuild = null;
    state.initPromise = null;
    state.initialized = false;
    throw new Error(
      `Failed to initialize esbuild-wasm: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
