/**
 * TypeScript type checking service for NatStack projects.
 *
 * Runs TypeScript's language service against on-disk sources with:
 *   - Workspace-package discovery (pnpm-workspace.yaml → name→dir map)
 *   - Automatic tsconfig.json loading + merging
 *   - Disk-aware module resolution (standard TS resolver sees node_modules,
 *     pnpm symlinks, package.json exports, etc. — no custom interception)
 *
 * Two escape hatches remain:
 *   1. `resolveWorkspaceModule` maps package names to source directories via
 *      the workspace context map. Needed for panels that aren't pnpm members
 *      (they have no local node_modules to walk) and as an optimisation for
 *      workspace packages so we go straight to source without a node_modules
 *      detour.
 *   2. Everything else flows through `ts.resolveModuleName` with a disk-aware
 *      module resolution host.
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import {
  discoverWorkspaceContext,
  resolveExportSubpath,
  WORKSPACE_CONDITIONS,
  type WorkspaceContext,
} from "./lib/index.js";
import { TS_LIB_FILES } from "./lib/typescript-libs.js";

/** Shared diagnostic shape (position + severity only). */
export interface BaseDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
}

/** Full diagnostic — adds the TypeScript code and category. */
export interface TypeCheckDiagnostic extends BaseDiagnostic {
  code: number;
  category: ts.DiagnosticCategory;
}

/** Result of a type-check run. */
export interface TypeCheckResult {
  panelPath: string;
  diagnostics: TypeCheckDiagnostic[];
  timestamp: number;
  checkedFiles: string[];
}

/** Hover / quick-info result. */
export interface QuickInfo {
  displayParts: string;
  documentation?: string;
  tags?: { name: string; text?: string }[];
}

/**
 * Configuration for the TypeCheckService.
 */
export interface TypeCheckServiceConfig {
  /** Root path of the panel/package being checked. Also the cwd for tsconfig
   *  discovery and module resolution. */
  panelPath: string;
  /** Override TypeScript compiler options. Merged on top of defaults + any
   *  loaded tsconfig.json. `noEmit` is always forced to true. */
  compilerOptions?: ts.CompilerOptions;
  /** Skip suggestion diagnostics for a faster check (errors + warnings only). */
  skipSuggestions?: boolean;
  /** Pre-discovered workspace context. When omitted, we walk up from
   *  `panelPath` looking for a pnpm-workspace.yaml. Pass `null` to skip
   *  discovery entirely (unresolved workspace imports fall through to
   *  standard TS resolution). */
  workspaceContext?: WorkspaceContext | null;
  /** Opt out of automatic tsconfig.json discovery — useful for hermetic tests. */
  disableTsconfigDiscovery?: boolean;
}

/**
 * TypeScript type checking service.
 */
export class TypeCheckService {
  private languageService: ts.LanguageService;
  private files = new Map<string, { content: string; version: number }>();
  private config: TypeCheckServiceConfig;
  /** Workspace context (monorepo root + package map) for source-based resolution */
  private workspaceContext: WorkspaceContext | null = null;
  /** Cache of disk file existence checks */
  private diskFileExistsCache = new Map<string, boolean>();
  /** Cached merged compiler options (defaults + tsconfig + overrides) */
  private cachedCompilerOptions: ts.CompilerOptions | null = null;
  /** Whether we've already attempted to load tsconfig.json */
  private tsconfigOptionsLoaded = false;
  /** Cached compilerOptions loaded from tsconfig.json (if any) */
  private tsconfigOptionsCache: ts.CompilerOptions | null = null;
  /** TypeScript module resolution cache for ts.resolveModuleName */
  private tsResolutionCache: ts.ModuleResolutionCache | null = null;

  constructor(config: TypeCheckServiceConfig) {
    this.config = config;

    // `null` = explicitly skip discovery. `undefined` = auto-discover.
    if (config.workspaceContext === null) {
      this.workspaceContext = null;
    } else if (config.workspaceContext) {
      this.workspaceContext = config.workspaceContext;
    } else {
      this.workspaceContext = discoverWorkspaceContext(config.panelPath);
    }

    this.addBundledLibFiles();
    this.languageService = this.createLanguageService();
  }

  /**
   * Register the bundled `lib.*.d.ts` files into the virtual file map so
   * TypeScript's language service can find them via `getScriptSnapshot`.
   */
  private addBundledLibFiles(): void {
    for (const [libName, content] of Object.entries(TS_LIB_FILES)) {
      this.files.set(`/@typescript/lib/${libName}`, { content, version: 1 });
    }
  }

  // ===========================================================================
  // File registration
  // ===========================================================================

  updateFile(filePath: string, content: string): void {
    const existing = this.files.get(filePath);
    this.files.set(filePath, {
      content,
      version: (existing?.version ?? 0) + 1,
    });
    this.invalidateTsResolutionCache();
  }

  removeFile(filePath: string): void {
    this.files.delete(filePath);
    this.invalidateTsResolutionCache();
  }

  hasFile(filePath: string): boolean {
    return this.files.has(filePath);
  }

  /**
   * Paths of files we'd ask TypeScript to check when no specific file is
   * requested. Excludes the bundled lib stubs.
   */
  getFileNames(): string[] {
    return [...this.files.keys()].filter((p) => !p.startsWith("/@typescript/lib/"));
  }

  // ===========================================================================
  // Diagnostics
  // ===========================================================================

  check(filePath?: string): TypeCheckResult {
    const diagnostics = filePath
      ? this.getFileDiagnostics(filePath)
      : this.getAllDiagnostics();

    return {
      panelPath: this.config.panelPath,
      diagnostics,
      timestamp: Date.now(),
      checkedFiles: filePath ? [filePath] : this.getFileNames(),
    };
  }

  private getFileDiagnostics(filePath: string): TypeCheckDiagnostic[] {
    const syntactic = this.languageService.getSyntacticDiagnostics(filePath);
    const semantic = this.languageService.getSemanticDiagnostics(filePath);

    const result = [
      ...syntactic.map((d) => this.convertDiagnostic(d, "error")),
      ...semantic.map((d) => this.convertDiagnostic(d)),
    ];

    if (!this.config.skipSuggestions) {
      const suggestion = this.languageService.getSuggestionDiagnostics(filePath);
      result.push(...suggestion.map((d) => this.convertDiagnostic(d, "info")));
    }

    return result;
  }

  private getAllDiagnostics(): TypeCheckDiagnostic[] {
    const diagnostics: TypeCheckDiagnostic[] = [];
    for (const fileName of this.getFileNames()) {
      diagnostics.push(...this.getFileDiagnostics(fileName));
    }
    return diagnostics;
  }

  private convertDiagnostic(
    diagnostic: ts.Diagnostic,
    forceSeverity?: "error" | "warning" | "info"
  ): TypeCheckDiagnostic {
    const severity = forceSeverity ?? this.categoryToSeverity(diagnostic.category);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

    let file = "";
    let line = 1;
    let column = 1;
    let endLine: number | undefined;
    let endColumn: number | undefined;

    if (diagnostic.file && diagnostic.start !== undefined) {
      file = diagnostic.file.fileName;
      const startPos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      line = startPos.line + 1;
      column = startPos.character + 1;

      if (diagnostic.length !== undefined) {
        const endPos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start + diagnostic.length);
        endLine = endPos.line + 1;
        endColumn = endPos.character + 1;
      }
    }

    return {
      file,
      line,
      column,
      endLine,
      endColumn,
      message,
      code: diagnostic.code,
      severity,
      category: diagnostic.category,
    };
  }

  private categoryToSeverity(category: ts.DiagnosticCategory): "error" | "warning" | "info" {
    switch (category) {
      case ts.DiagnosticCategory.Error: return "error";
      case ts.DiagnosticCategory.Warning: return "warning";
      default: return "info";
    }
  }

  // ===========================================================================
  // Editor operations (hover, completions, definition)
  // ===========================================================================

  getQuickInfo(filePath: string, line: number, column: number): QuickInfo | null {
    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return null;

    const info = this.languageService.getQuickInfoAtPosition(filePath, position);
    if (!info) return null;

    return {
      displayParts: ts.displayPartsToString(info.displayParts),
      documentation: info.documentation ? ts.displayPartsToString(info.documentation) : undefined,
      tags: info.tags?.map((t) => ({
        name: t.name,
        text: t.text ? ts.displayPartsToString(t.text) : undefined,
      })),
    };
  }

  getCompletions(filePath: string, line: number, column: number): ts.CompletionInfo | undefined {
    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return undefined;
    return this.languageService.getCompletionsAtPosition(filePath, position, undefined);
  }

  getDefinition(filePath: string, line: number, column: number): readonly ts.DefinitionInfo[] | undefined {
    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return undefined;
    return this.languageService.getDefinitionAtPosition(filePath, position);
  }

  getProgram(): ts.Program | undefined {
    return this.languageService.getProgram();
  }

  /**
   * Convert line/column (1-based) to offset position. Reuses the source file
   * from the language service's program when available to avoid redundant
   * AST parsing.
   */
  private getPosition(filePath: string, line: number, column: number): number | undefined {
    const program = this.languageService.getProgram();
    const sourceFile = program?.getSourceFile(filePath);

    if (sourceFile) {
      try {
        return sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
      } catch {
        return undefined;
      }
    }

    const file = this.files.get(filePath);
    if (!file) return undefined;

    const tempSourceFile = ts.createSourceFile(filePath, file.content, ts.ScriptTarget.Latest, true);
    try {
      return tempSourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
    } catch {
      return undefined;
    }
  }

  // ===========================================================================
  // Language service host
  // ===========================================================================

  private createLanguageService(): ts.LanguageService {
    const self = this;

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.getCompilerOptions(),
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: (fileName) => String(this.files.get(fileName)?.version ?? 0),
      getScriptSnapshot: (fileName) => {
        const file = this.files.get(fileName);
        if (file) return ts.ScriptSnapshot.fromString(file.content);
        if (this.isVirtualPath(fileName)) return undefined;
        if (this.diskFileExists(fileName)) {
          try {
            return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, "utf-8"));
          } catch {
            return undefined;
          }
        }
        return undefined;
      },
      getCurrentDirectory: () => this.config.panelPath,
      getDefaultLibFileName: () => "/@typescript/lib/lib.es5.d.ts",
      fileExists: (filePath) => {
        if (this.files.has(filePath)) return true;
        if (this.isVirtualPath(filePath)) return false;
        return this.diskFileExists(filePath);
      },
      readFile: (filePath) => {
        const file = this.files.get(filePath);
        if (file) return file.content;
        if (this.isVirtualPath(filePath)) return undefined;
        if (this.diskFileExists(filePath)) {
          try { return fs.readFileSync(filePath, "utf-8"); } catch { return undefined; }
        }
        return undefined;
      },
      directoryExists: (dirPath) => {
        if (this.isVirtualPath(dirPath)) return false;
        try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
      },
      getDirectories: (dirPath) => {
        if (this.isVirtualPath(dirPath)) return [];
        try {
          return fs.readdirSync(dirPath, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch {
          return [];
        }
      },
      realpath: (p) => {
        try { return fs.realpathSync(p); } catch { return p; }
      },

      resolveModuleNameLiterals(
        moduleLiterals: readonly ts.StringLiteralLike[],
        containingFile: string,
        _redirectedReference: ts.ResolvedProjectReference | undefined,
        options: ts.CompilerOptions
      ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
        return moduleLiterals.map(({ text: moduleName }) =>
          self.resolveModuleName(moduleName, containingFile, options)
        );
      },
    };

    return ts.createLanguageService(host);
  }

  /**
   * Paths under `/@typescript/lib/` are synthesized for bundled lib files and
   * must not fall through to disk (the names don't correspond to real paths).
   */
  private isVirtualPath(filePath: string): boolean {
    return filePath.startsWith("/@typescript/");
  }

  // ===========================================================================
  // Module resolution
  // ===========================================================================

  /**
   * Resolve a module specifier. Two steps:
   *   1. Look the name up in the workspace context map. This is a shortcut for
   *      workspace packages (source-based, no `node_modules/` detour) and the
   *      only way panels — which have no local `node_modules` — can find their
   *      workspace deps.
   *   2. Fall through to standard TypeScript resolution with a disk-aware host
   *      so the compiler walks `node_modules/`, follows symlinks, and reads
   *      `package.json` exports on its own.
   */
  private resolveModuleName(
    moduleName: string,
    containingFile: string,
    options: ts.CompilerOptions
  ): ts.ResolvedModuleWithFailedLookupLocations {
    if (this.workspaceContext) {
      const fromContext = this.resolveFromWorkspaceContext(moduleName);
      if (fromContext) return fromContext;
    }

    return ts.resolveModuleName(
      moduleName,
      containingFile,
      options,
      this.createDiskAwareModuleHost(),
      this.getTsResolutionCache()
    );
  }

  /**
   * `ts.ModuleResolutionHost` that reads from disk (with caching) and routes
   * virtual lib paths through the in-memory file map. Used by the standard
   * fallback resolution path.
   */
  private createDiskAwareModuleHost(): ts.ModuleResolutionHost {
    return {
      fileExists: (p) => {
        if (this.files.has(p)) return true;
        if (this.isVirtualPath(p)) return false;
        return this.diskFileExists(p);
      },
      readFile: (p) => {
        const file = this.files.get(p);
        if (file) return file.content;
        if (this.isVirtualPath(p)) return undefined;
        try { return fs.readFileSync(p, "utf-8"); } catch { return undefined; }
      },
      directoryExists: (p) => {
        if (this.isVirtualPath(p)) return false;
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
      },
      getDirectories: (p) => {
        if (this.isVirtualPath(p)) return [];
        try {
          return fs.readdirSync(p, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch {
          return [];
        }
      },
      realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
    };
  }

  /**
   * Resolve a module name against the workspace package map.
   *
   * Tries progressively shorter prefixes so subpath imports like
   * `@scope/foo/sub` match package `@scope/foo` with subpath `./sub`.
   */
  private resolveFromWorkspaceContext(
    moduleName: string,
  ): ts.ResolvedModuleWithFailedLookupLocations | null {
    const ctx = this.workspaceContext;
    if (!ctx) return null;

    const parts = moduleName.split("/");
    const minParts = moduleName.startsWith("@") ? 2 : 1;
    for (let i = parts.length; i >= minParts; i--) {
      const pkgName = parts.slice(0, i).join("/");
      const info = ctx.packages.get(pkgName);
      if (!info) continue;

      const subpath = i < parts.length ? parts.slice(i).join("/") : null;
      return this.resolvePackageSubpath(info.dir, info.packageJson, subpath);
    }
    return null;
  }

  /**
   * Resolve a (subpath?) inside a known package directory using
   * package.json exports, then types/module/main, then index.{ts,tsx,d.ts}.
   */
  private resolvePackageSubpath(
    packageDir: string,
    packageJson: { exports?: unknown; types?: string; typings?: string; main?: string; module?: string },
    subpath: string | null,
  ): ts.ResolvedModuleWithFailedLookupLocations | null {
    let resolvedFile: string | null = null;

    if (packageJson.exports && typeof packageJson.exports === "object") {
      const exportKey = subpath ? `./${subpath}` : ".";
      const target = resolveExportSubpath(
        packageJson.exports as Record<string, unknown>,
        exportKey,
        WORKSPACE_CONDITIONS,
      );
      if (target) {
        resolvedFile = path.join(packageDir, target);
      }
    }

    if (!resolvedFile && !subpath) {
      const candidates = [packageJson.types, packageJson.typings, packageJson.module, packageJson.main];
      for (const candidate of candidates) {
        if (candidate) { resolvedFile = path.join(packageDir, candidate); break; }
      }
      if (!resolvedFile) {
        for (const ext of [".ts", ".tsx", ".d.ts"]) {
          const indexPath = path.join(packageDir, `index${ext}`);
          if (this.diskFileExists(indexPath)) { resolvedFile = indexPath; break; }
        }
      }
      if (!resolvedFile) {
        // Some packages put their entry in src/
        for (const ext of [".ts", ".tsx", ".d.ts"]) {
          const indexPath = path.join(packageDir, "src", `index${ext}`);
          if (this.diskFileExists(indexPath)) { resolvedFile = indexPath; break; }
        }
      }
    }

    if (!resolvedFile && subpath) {
      // Subpath import that didn't match exports — try direct file lookup.
      for (const ext of [".ts", ".tsx", ".d.ts", ".js"]) {
        const candidate = path.join(packageDir, `${subpath}${ext}`);
        if (this.diskFileExists(candidate)) { resolvedFile = candidate; break; }
      }
      if (!resolvedFile) {
        for (const ext of [".ts", ".tsx", ".d.ts"]) {
          const candidate = path.join(packageDir, subpath, `index${ext}`);
          if (this.diskFileExists(candidate)) { resolvedFile = candidate; break; }
        }
      }
    }

    if (!resolvedFile || !this.diskFileExists(resolvedFile)) return null;

    return {
      resolvedModule: {
        resolvedFileName: resolvedFile,
        isExternalLibraryImport: false,
        extension: this.getExtensionForPath(resolvedFile),
      },
    };
  }

  private getExtensionForPath(filePath: string): ts.Extension {
    if (filePath.endsWith(".tsx")) return ts.Extension.Tsx;
    if (filePath.endsWith(".d.ts")) return ts.Extension.Dts;
    if (filePath.endsWith(".ts")) return ts.Extension.Ts;
    if (filePath.endsWith(".jsx")) return ts.Extension.Jsx;
    if (filePath.endsWith(".js")) return ts.Extension.Js;
    return ts.Extension.Ts;
  }

  /** Cached disk file existence check. */
  private diskFileExists(filePath: string): boolean {
    const cached = this.diskFileExistsCache.get(filePath);
    if (cached !== undefined) return cached;
    const exists = fs.existsSync(filePath);
    this.diskFileExistsCache.set(filePath, exists);
    return exists;
  }

  // ===========================================================================
  // Compiler options
  // ===========================================================================

  /**
   * Merged compiler options.
   *
   * Resolution order (highest priority first):
   *   1. Forced overrides (noEmit, skipLibCheck)
   *   2. Caller-supplied `compilerOptions`
   *   3. Options loaded from the target's tsconfig.json (auto-detected)
   *   4. Hardcoded defaults
   */
  private getCompilerOptions(): ts.CompilerOptions {
    if (this.cachedCompilerOptions) return this.cachedCompilerOptions;
    const merged: ts.CompilerOptions = {
      ...this.getDefaultCompilerOptions(),
      ...this.loadTsconfigCompilerOptions(),
      ...this.config.compilerOptions,
      noEmit: true,
      skipLibCheck: this.config.compilerOptions?.skipLibCheck ?? true,
    };
    this.cachedCompilerOptions = merged;
    return merged;
  }

  /**
   * Hardcoded fallback options — used when no tsconfig.json is found.
   * Tuned for the modern NatStack code shape (ESM, ES2023+, JSX, disposable
   * resources).
   */
  private getDefaultCompilerOptions(): ts.CompilerOptions {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      lib: [
        "lib.es2022.d.ts",
        "lib.es2023.array.d.ts",
        "lib.es2023.collection.d.ts",
        "lib.es2023.intl.d.ts",
        "lib.esnext.disposable.d.ts",
        "lib.esnext.iterator.d.ts",
        "lib.esnext.promise.d.ts",
        "lib.dom.d.ts",
        "lib.dom.iterable.d.ts",
      ],
      strict: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      isolatedModules: true,
    };
  }

  /**
   * Look for a tsconfig.json in `panelPath`, walking up to two levels so a
   * workspace package without its own tsconfig picks up the monorepo's
   * settings. Handles `extends` chains via TypeScript's own config parser.
   */
  private loadTsconfigCompilerOptions(): ts.CompilerOptions {
    if (this.config.disableTsconfigDiscovery) return {};
    if (this.tsconfigOptionsLoaded) return this.tsconfigOptionsCache ?? {};
    this.tsconfigOptionsLoaded = true;

    const candidates: string[] = [];
    let dir = this.config.panelPath;
    for (let i = 0; i < 3; i++) {
      candidates.push(path.join(dir, "tsconfig.json"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    let configPath: string | null = null;
    for (const candidate of candidates) {
      if (this.diskFileExists(candidate)) { configPath = candidate; break; }
    }
    if (!configPath) {
      this.tsconfigOptionsCache = {};
      return {};
    }

    try {
      const readResult = ts.readConfigFile(configPath, (p) => {
        try { return fs.readFileSync(p, "utf-8"); } catch { return undefined; }
      });
      if (readResult.error || !readResult.config) {
        this.tsconfigOptionsCache = {};
        return {};
      }
      const parsed = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        path.dirname(configPath),
      );
      const options: ts.CompilerOptions = { ...parsed.options };

      // Strip path-mapping config — we resolve workspace packages ourselves
      // and project paths often point at dist/ which doesn't exist here.
      delete options.paths;
      delete options.baseUrl;
      // Drop output-related fields to stay in pure check mode.
      delete options.outDir;
      delete options.outFile;
      delete options.declaration;
      delete options.declarationMap;
      delete options.sourceMap;
      delete options.composite;
      delete options.tsBuildInfoFile;
      // `rootDir` would otherwise constrain which files can be checked.
      delete options.rootDir;
      delete options.rootDirs;

      this.tsconfigOptionsCache = options;
      return options;
    } catch {
      this.tsconfigOptionsCache = {};
      return {};
    }
  }

  private getTsResolutionCache(): ts.ModuleResolutionCache {
    if (!this.tsResolutionCache) {
      this.tsResolutionCache = ts.createModuleResolutionCache(
        this.config.panelPath,
        (fileName) => fileName,
        this.getCompilerOptions()
      );
    }
    return this.tsResolutionCache;
  }

  private invalidateTsResolutionCache(): void {
    this.tsResolutionCache = null;
  }
}

/** Factory wrapper — kept for back-compat with existing call sites. */
export function createTypeCheckService(config: TypeCheckServiceConfig): TypeCheckService {
  return new TypeCheckService(config);
}
