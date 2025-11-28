/**
 * In-browser TypeScript type checking for panel builds.
 * Uses TypeScript's compiler API from prebundled runtime.
 */

import { getPrebundled } from './prebundled.js';

/**
 * TypeScript diagnostic message (can be string or nested structure)
 */
export type DiagnosticMessageChain = {
    messageText: string;
    category: number;
    code: number;
    next?: DiagnosticMessageChain[];
};

/**
 * TypeScript diagnostic
 */
export interface Diagnostic {
    file?: {
        fileName: string;
        getLineAndCharacterOfPosition(pos: number): { line: number; character: number };
    };
    start?: number;
    length?: number;
    messageText: string | DiagnosticMessageChain;
    category: number;
    code: number;
}

/**
 * TypeScript program
 */
export interface Program {
    getSyntacticDiagnostics(): Diagnostic[];
    getSemanticDiagnostics(): Diagnostic[];
    getDeclarationDiagnostics(): Diagnostic[];
}

/**
 * TypeScript source file
 */
export interface SourceFile {
    fileName: string;
    text: string;
}

/**
 * TypeScript compiler host
 */
export interface CompilerHost {
    getSourceFile(fileName: string): SourceFile | undefined;
    writeFile(): void;
    getCurrentDirectory(): string;
    getCanonicalFileName(fileName: string): string;
    useCaseSensitiveFileNames(): boolean;
    getNewLine(): string;
    fileExists(fileName: string): boolean;
    readFile(fileName: string): string | undefined;
    getDefaultLibFileName(): string;
}

/**
 * TypeScript compiler options
 */
export interface CompilerOptions {
    target?: number;
    module?: number;
    jsx?: number;
    strict?: boolean;
    esModuleInterop?: boolean;
    skipLibCheck?: boolean;
    moduleResolution?: number;
    noEmit?: boolean;
    allowJs?: boolean;
    checkJs?: boolean;
}

/**
 * Minimal TypeScript API surface needed for type checking
 */
export interface TypeScriptAPI {
    createProgram(options: {
        rootNames: string[];
        options: CompilerOptions;
        host: CompilerHost;
    }): Program;
    getPreEmitDiagnostics(program: Program): Diagnostic[];
    createSourceFile(fileName: string, sourceText: string, languageVersion: number): SourceFile;
    ScriptTarget: {
        Latest: number;
        ES2020: number;
    };
    ModuleKind: {
        ESNext: number;
    };
    JsxEmit: {
        ReactJSX: number;
    };
    ModuleResolutionKind: {
        Bundler: number;
    };
    getDefaultLibFileName(options: CompilerOptions): string;
    flattenDiagnosticMessageText(messageText: string | DiagnosticMessageChain, newLine: string): string;
}

/**
 * Type checking result
 */
export interface TypeCheckResult {
    success: boolean;
    errors: string[];
    errorCount: number;
}

/**
 * Cached TypeScript instance
 */
let typescriptInstance: TypeScriptAPI | null = null;

/**
 * Load TypeScript from prebundled runtime
 */
async function getTypeScript(): Promise<TypeScriptAPI> {
    if (typescriptInstance) {
        return typescriptInstance;
    }

    console.log('[TypeChecker] Loading TypeScript from prebundled runtime...');

    // Get prebundled TypeScript code
    const tsCode = getPrebundled('typescript');

    if (!tsCode) {
        throw new Error(
            'TypeScript not found in prebundled packages. ' +
            'Ensure typescript is included in DEFAULT_PREBUNDLED_PACKAGES and the build has run.'
        );
    }

    try {
        // Create a data URL from the TypeScript code
        const dataUrl = `data:text/javascript;base64,${btoa(tsCode)}`;

        // Import TypeScript from the data URL
        const ts = await import(/* @vite-ignore */ dataUrl);
        typescriptInstance = (ts.default || ts) as TypeScriptAPI;

        console.log('[TypeChecker] TypeScript loaded successfully from prebundled runtime');
        return typescriptInstance;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load TypeScript from prebundled runtime: ${errorMessage}`);
    }
}

/**
 * Create a virtual compiler host for in-memory files
 */
function createVirtualCompilerHost(
    ts: TypeScriptAPI,
    files: Map<string, string>
): CompilerHost {
    // Add TypeScript lib files (minimal set for browser)
    const libFileName = ts.getDefaultLibFileName({ target: ts.ScriptTarget.ES2020 });

    return {
        getSourceFile: (fileName: string) => {
            // Check virtual files first
            const content = files.get(fileName);
            if (content !== undefined) {
                return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest);
            }

            // For lib files, return undefined (TypeScript will use built-in libs)
            if (fileName.includes('lib.') && fileName.endsWith('.d.ts')) {
                return undefined;
            }

            return undefined;
        },
        writeFile: () => {
            // No-op, we don't emit files
        },
        getCurrentDirectory: () => '/',
        getCanonicalFileName: (fileName: string) => fileName,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (fileName: string) => {
            if (files.has(fileName)) return true;
            // Pretend lib files exist
            if (fileName.includes('lib.') && fileName.endsWith('.d.ts')) return true;
            return false;
        },
        readFile: (fileName: string) => files.get(fileName),
        getDefaultLibFileName: () => libFileName,
    };
}

/**
 * Format a TypeScript diagnostic into a readable error message
 */
function formatDiagnostic(ts: TypeScriptAPI, diagnostic: Diagnostic): string {
    if (diagnostic.file && diagnostic.start !== undefined) {
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        const fileName = diagnostic.file.fileName;
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

        return `${fileName}:${line + 1}:${character + 1} - error TS${diagnostic.code}: ${message}`;
    } else {
        return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    }
}

/**
 * Default TypeScript compiler options for panel builds
 */
function getDefaultCompilerOptions(ts: TypeScriptAPI): CompilerOptions {
    return {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        allowJs: true,
        checkJs: false,
    };
}

/**
 * Type check a panel's source files
 * 
 * @param files - Map of file paths to file contents
 * @param compilerOptions - Optional TypeScript compiler options
 * @returns Type checking result with errors
 */
export async function typeCheckPanel(
    files: Map<string, string>,
    compilerOptions?: CompilerOptions
): Promise<TypeCheckResult> {
    try {
        console.log(`[TypeChecker] Type checking ${files.size} files...`);

        // Load TypeScript from prebundled runtime
        const ts = await getTypeScript();

        // Create virtual compiler host
        const host = createVirtualCompilerHost(ts, files);

        // Get compiler options
        const options = compilerOptions || getDefaultCompilerOptions(ts);

        // Create program
        const rootNames = Array.from(files.keys());
        const program = ts.createProgram({
            rootNames,
            options,
            host,
        });

        // Get diagnostics
        const diagnostics = ts.getPreEmitDiagnostics(program);

        // Format errors
        const errors = diagnostics.map((d: Diagnostic) => formatDiagnostic(ts, d));

        if (diagnostics.length > 0) {
            console.error(`[TypeChecker] Found ${diagnostics.length} type error(s):`);
            errors.forEach((err: string) => console.error(`  ${err}`));
        } else {
            console.log('[TypeChecker] Type checking passed!');
        }

        return {
            success: diagnostics.length === 0,
            errors,
            errorCount: diagnostics.length,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[TypeChecker] Type checking failed:', errorMessage);

        return {
            success: false,
            errors: [`Type checker initialization failed: ${errorMessage}`],
            errorCount: 1,
        };
    }
}

/**
 * Check if TypeScript is already loaded
 */
export function isTypeScriptLoaded(): boolean {
    return typescriptInstance !== null;
}

/**
 * Preload TypeScript compiler (useful for warming up cache)
 */
export async function preloadTypeScript(): Promise<void> {
    await getTypeScript();
}
