/**
 * modern-monaco initialization and utilities.
 *
 * Replaces monacoWorkers.ts - modern-monaco handles workers automatically
 * via blob URLs, eliminating the need for complex environment configuration.
 */
import { init } from "modern-monaco";

/** Monaco namespace type - inferred from init() return type */
export type MonacoNamespace = Awaited<ReturnType<typeof init>>;

let monacoInstance: MonacoNamespace | null = null;
let initPromise: Promise<MonacoNamespace> | null = null;

/**
 * Get initialized Monaco instance.
 * Returns cached instance or initializes on first call.
 *
 * modern-monaco automatically:
 * - Handles worker creation via blob URLs (NO MonacoEnvironment setup)
 * - Uses Shiki for syntax highlighting (lighter than Monaco's language services)
 * - Provides LSP integration for HTML, CSS, JS/TS, JSON
 */
export async function getMonaco(): Promise<MonacoNamespace> {
  if (monacoInstance) return monacoInstance;

  if (!initPromise) {
    initPromise = init({
      // Configure LSP providers for TypeScript
      // CompilerOptions use TypeScript ScriptTarget/ModuleKind numeric values:
      // target: 9 = ES2022, module: 99 = ESNext, moduleResolution: 100 = Bundler
      // jsx: 4 = ReactJSX
      lsp: {
        typescript: {
          compilerOptions: {
            target: 9, // ES2022
            module: 99, // ESNext
            moduleResolution: 100, // Bundler
            jsx: 4, // ReactJSX
            strict: true,
            skipLibCheck: true,
            esModuleInterop: true,
          },
        },
      },
    }).then((monaco) => {
      monacoInstance = monaco;
      return monaco;
    });
  }

  return initPromise;
}

/**
 * Check if Monaco is already initialized.
 */
export function isMonacoReady(): boolean {
  return monacoInstance !== null;
}

/**
 * Get Monaco instance synchronously (throws if not initialized).
 * Use this only when you're certain Monaco has already been initialized.
 */
export function getMonacoSync(): MonacoNamespace {
  if (!monacoInstance) {
    throw new Error("Monaco not initialized. Call getMonaco() first.");
  }
  return monacoInstance;
}
