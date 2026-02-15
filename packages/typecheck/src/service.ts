/**
 * TypeScript type checking service for NatStack panels and workers.
 *
 * This service provides type checking with module resolution that matches
 * the panel build system, ensuring developers get accurate feedback without
 * needing to configure tsconfig files.
 *
 * Key features:
 * - Custom module resolution (fs shim, @workspace/*, dedupe)
 * - Virtual type definitions for shimmed APIs
 * - Language service integration (diagnostics, completions, hover)
 * - File watching with incremental updates
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import {
  type ModuleResolutionConfig,
  resolveModule,
  resolveExportSubpath,
  WORKSPACE_CONDITIONS,
  DEFAULT_DEDUPE_PACKAGES,
} from "./resolution.js";
import { FS_TYPE_DEFINITIONS, PATH_TYPE_DEFINITIONS, GLOBAL_TYPE_DEFINITIONS, NODE_BUILTIN_TYPE_STUBS, NODE_FS_TYPE_DEFINITIONS, loadNatstackPackageTypes, findPackagesDir, type NatstackPackageTypes } from "./lib/index.js";
import { TS_LIB_FILES } from "./lib/typescript-libs.js";
import { createTypeDefinitionLoader, type TypeDefinitionLoader } from "./loader.js";

/**
 * Base diagnostic fields shared between internal and external types.
 * Use this type when only the core diagnostic fields are needed.
 */
export interface BaseDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
}

/**
 * Full diagnostic from the type checker (internal use).
 * Extends BaseDiagnostic with TypeScript-specific fields.
 */
export interface TypeCheckDiagnostic extends BaseDiagnostic {
  code: number;
  category: ts.DiagnosticCategory;
}

/**
 * Result of type checking a panel/worker.
 */
export interface TypeCheckResult {
  /** Path to the panel/worker being checked */
  panelPath: string;
  /** All diagnostics found */
  diagnostics: TypeCheckDiagnostic[];
  /** When the check was performed */
  timestamp: number;
  /** Files that were checked */
  checkedFiles: string[];
}

/**
 * Quick info (hover) result.
 */
export interface QuickInfo {
  /** Display parts for the type */
  displayParts: string;
  /** Documentation if available */
  documentation?: string;
  /** Tags (deprecated, etc.) */
  tags?: { name: string; text?: string }[];
}

/**
 * Result of loading external types.
 */
export interface ExternalTypesResult {
  /** Map of file paths to their contents */
  files: Map<string, string>;
  /** Package names that this package references (via /// <reference types="..." />) */
  referencedPackages?: string[];
  /** The main entry point file path (e.g., "index.d.ts" or "dist/index.d.ts") */
  entryPoint?: string;
  /** Subpath exports (e.g., "./jsx-runtime" -> "jsx-runtime.d.ts") */
  subpaths?: Map<string, string>;
}

/**
 * Configuration for the TypeCheckService.
 */
export interface TypeCheckServiceConfig {
  /** Root path of the panel/worker being checked */
  panelPath: string;
  /** Module resolution configuration */
  resolution?: Partial<ModuleResolutionConfig>;
  /** TypeScript compiler options override */
  compilerOptions?: ts.CompilerOptions;
  /** Path to lib.d.ts files */
  libPath?: string;
  /**
   * Callback to fetch external package types on-demand.
   * Returns files map and optionally referenced packages that should also be loaded.
   */
  requestExternalTypes?: (packageName: string) => Promise<ExternalTypesResult | null>;
  /**
   * Path to the monorepo root (containing packages directory).
   * If provided, natstack types are loaded from packages dist folders.
   * This enables dynamic type loading without bundled workspace-packages.ts.
   */
  workspaceRoot?: string;
  /**
   * Skip suggestion diagnostics for faster checking.
   * Use for build-time checks where only errors matter.
   */
  skipSuggestions?: boolean;
  /**
   * Paths to node_modules directories to load types from directly.
   * When set, types are loaded from these paths using TypeDefinitionLoader
   * instead of using the requestExternalTypes callback.
   * This is more efficient for build-time type checking where packages
   * are already installed.
   */
  nodeModulesPaths?: string[];
  /**
   * Path to the user's workspace root.
   * If provided, enables resolution of @workspace-panels/* and @workspace-agents/*
   * from workspace/panels/ and workspace/agents/ directories.
   */
  userWorkspacePath?: string;
}

/**
 * TypeScript type checking service for NatStack panels/workers.
 */
export class TypeCheckService {
  private languageService: ts.LanguageService;
  private files = new Map<string, { content: string; version: number }>();
  private config: TypeCheckServiceConfig;
  private resolutionConfig: ModuleResolutionConfig;

  /** Packages that we've attempted to load types for */
  private loadedExternalPackages = new Set<string>();
  /** Packages that need types fetched (collected during resolution) */
  private pendingExternalPackages = new Set<string>();
  /** Loaded @workspace/* package types (dynamically loaded from filesystem) */
  private natstackPackageTypes: Record<string, NatstackPackageTypes> = {};
  /** Entry points for loaded external packages (package name -> entry file path) */
  private externalPackageEntryPoints = new Map<string, string>();
  /** Subpath exports for loaded external packages (package name -> (subpath -> file path)) */
  private externalPackageSubpaths = new Map<string, Map<string, string>>();
  /** Cache for module resolution results to avoid O(n) scans */
  private resolvedModuleCache = new Map<string, string | null>();
  /** TypeScript module resolution cache for ts.resolveModuleName */
  private tsResolutionCache: ts.ModuleResolutionCache | null = null;
  /** Type definition loader for direct filesystem access (when nodeModulesPaths is set) */
  private typeLoader: TypeDefinitionLoader | null = null;

  constructor(config: TypeCheckServiceConfig) {
    this.config = config;
    this.resolutionConfig = {
      fsShimEnabled: config.resolution?.fsShimEnabled ?? true,
      dedupePackages: config.resolution?.dedupePackages ?? [...DEFAULT_DEDUPE_PACKAGES],
      runtimeNodeModules: config.resolution?.runtimeNodeModules,
    };

    // Initialize type loader if nodeModulesPaths is provided
    if (config.nodeModulesPaths && config.nodeModulesPaths.length > 0) {
      this.typeLoader = createTypeDefinitionLoader({
        nodeModulesPaths: config.nodeModulesPaths,
      });
    }

    // Add virtual type definitions
    this.addVirtualLibs();

    this.languageService = this.createLanguageService();
  }

  /**
   * Add virtual type definition files for shimmed APIs and TypeScript libs.
   */
  private addVirtualLibs(): void {
    // Add fs type definitions
    this.files.set("/@workspace/virtual/fs.d.ts", {
      content: FS_TYPE_DEFINITIONS,
      version: 1,
    });

    // Add path type definitions (for path shim -> pathe)
    this.files.set("/@workspace/virtual/path.d.ts", {
      content: PATH_TYPE_DEFINITIONS,
      version: 1,
    });

    // Add global type definitions
    this.files.set("/@workspace/virtual/globals.d.ts", {
      content: GLOBAL_TYPE_DEFINITIONS,
      version: 1,
    });

    // Add Node.js built-in module type definitions (for workers)
    this.files.set("/@workspace/virtual/node-builtins.d.ts", {
      content: NODE_BUILTIN_TYPE_STUBS,
      version: 1,
    });

    // Add node: prefix module declarations (for workers using node:fs, node:path, etc.)
    this.files.set("/@workspace/virtual/node-prefix-modules.d.ts", {
      content: NODE_FS_TYPE_DEFINITIONS,
      version: 1,
    });

    // Add bundled TypeScript lib files (ES2022, DOM, etc.)
    for (const [libName, content] of Object.entries(TS_LIB_FILES)) {
      this.files.set(`/@typescript/lib/${libName}`, {
        content,
        version: 1,
      });
    }

    // Load @workspace/* package types dynamically from filesystem (including runtime)
    const packagesDir = this.config.workspaceRoot
      ? findPackagesDir(this.config.workspaceRoot)
      : null;

    if (packagesDir) {
      this.natstackPackageTypes = loadNatstackPackageTypes(packagesDir);
      for (const [pkgName, pkgData] of Object.entries(this.natstackPackageTypes)) {
        for (const [fileName, content] of Object.entries(pkgData.files)) {
          this.files.set(`/@workspace/packages/${pkgName}/${fileName}`, {
            content,
            version: 1,
          });
        }
      }
    }
  }

  /**
   * Update or add a file's content.
   * Call this when a file is created or modified.
   */
  updateFile(path: string, content: string): void {
    const existing = this.files.get(path);
    this.files.set(path, {
      content,
      version: (existing?.version ?? 0) + 1,
    });
    this.invalidateTsResolutionCache();
  }

  /**
   * Remove a file from the service.
   * Call this when a file is deleted.
   */
  removeFile(path: string): void {
    this.files.delete(path);
    this.invalidateTsResolutionCache();
  }

  /**
   * Check if a file exists in the service.
   */
  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  /**
   * Get all file paths tracked by the service.
   * Excludes virtual type definition files (libs, external types).
   */
  getFileNames(): string[] {
    return [...this.files.keys()].filter(
      (p) =>
        !p.startsWith("/@workspace/virtual/") &&
        !p.startsWith("/@types/") &&
        !p.startsWith("/@typescript/lib/")
    );
  }

  /**
   * Run type checking on a single file or all files.
   */
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

  /**
   * Load types for packages that were encountered during resolution but not yet available.
   * Returns true if new types were loaded (caller should re-check for updated diagnostics).
   *
   * When nodeModulesPaths is configured, loads directly from filesystem using TypeDefinitionLoader.
   * Otherwise, fires requests concurrently to be batched by TypeDefinitionService.
   */
  async loadPendingTypes(): Promise<boolean> {
    // Need either typeLoader (direct filesystem) or requestExternalTypes (RPC callback)
    if (!this.typeLoader && !this.config.requestExternalTypes) {
      return false;
    }

    if (this.pendingExternalPackages.size === 0) {
      return false;
    }

    const packages = [...this.pendingExternalPackages];
    this.pendingExternalPackages.clear();

    // Filter out already-loaded packages and mark remaining as attempted
    const toLoad = packages.filter(pkg => {
      if (this.loadedExternalPackages.has(pkg)) {
        return false;
      }
      this.loadedExternalPackages.add(pkg);
      return true;
    });

    if (toLoad.length === 0) {
      return false;
    }

    // Use typeLoader for direct filesystem access, or requestExternalTypes for RPC
    const results = await Promise.allSettled(
      toLoad.map(pkg => this.loadTypesForPackage(pkg))
    );

    let loadedAny = false;

    for (let i = 0; i < toLoad.length; i++) {
      const pkg = toLoad[i]!;
      const result = results[i]!;

      if (result.status === "rejected") {
        console.error(`[typecheck] Failed to load types for ${pkg}:`, result.reason);
        continue;
      }

      const value = result.value;
      if (!value) continue;

      const files = value.files;
      const referencedPackages = value.referencedPackages;
      const entryPoint = value.entryPoint;
      const subpaths = value.subpaths;

      if (files && files.size > 0) {
        for (const [filePath, content] of files) {
          // Store types with a consistent path prefix
          const typePath = `/@types/${pkg}/${filePath}`;
          this.files.set(typePath, { content, version: 1 });
        }
        loadedAny = true;

        // Store entry point for this package (used by findLoadedTypesEntry)
        if (entryPoint) {
          this.externalPackageEntryPoints.set(pkg, entryPoint);
        }

        // Store subpath exports for this package
        if (subpaths && subpaths.size > 0) {
          this.externalPackageSubpaths.set(pkg, subpaths);
        }
      }

      // Queue referenced packages for loading (e.g., /// <reference types="scheduler" />)
      if (referencedPackages) {
        for (const refPkg of referencedPackages) {
          if (!this.loadedExternalPackages.has(refPkg)) {
            this.pendingExternalPackages.add(refPkg);
          }
        }
      }
    }

    // Clear module resolution cache when new types are loaded
    if (loadedAny) {
      this.resolvedModuleCache.clear();
    }

    return loadedAny;
  }

  /**
   * Load types for a single package.
   * Uses typeLoader for direct filesystem access when available,
   * otherwise falls back to requestExternalTypes callback.
   */
  private async loadTypesForPackage(packageName: string): Promise<ExternalTypesResult | null> {
    // Prefer direct filesystem access when nodeModulesPaths is configured
    if (this.typeLoader) {
      const result = await this.typeLoader.loadPackageTypes(packageName);
      if (result && result.files.size > 0) {
        return {
          files: result.files,
          referencedPackages: result.referencedPackages,
          entryPoint: result.entryPoint ?? undefined,
          subpaths: result.subpaths.size > 0 ? result.subpaths : undefined,
        };
      }
      return null;
    }

    // Fall back to requestExternalTypes callback (RPC to main process)
    if (this.config.requestExternalTypes) {
      return this.config.requestExternalTypes(packageName);
    }

    return null;
  }

  /**
   * Check if there are pending external packages that need types loaded.
   */
  hasPendingTypes(): boolean {
    return this.pendingExternalPackages.size > 0;
  }

  /**
   * Run type checking with automatic external type loading.
   * This is the recommended way to check - it handles the async type loading cycle.
   *
   * The check-load-recheck pattern loops until no more pending types:
   * 1. Check - may discover packages needing external types
   * 2. Load any pending external types (requires requestExternalTypes callback)
   * 3. If new types were loaded, go back to step 1 (handles transitive deps)
   * 4. Return final diagnostics when no more pending types
   */
  async checkWithExternalTypes(filePath?: string, maxIterations: number = 10): Promise<TypeCheckResult> {
    let result = this.check(filePath);
    let iterations = 0;

    // Loop until no more pending types (handles transitive dependencies)
    while (this.hasPendingTypes() && iterations < maxIterations) {
      iterations++;
      const loadedNew = await this.loadPendingTypes();

      if (loadedNew) {
        // Re-check to discover any new pending types from loaded packages
        result = this.check(filePath);
      } else {
        // No new types loaded, stop iterating
        break;
      }
    }

    return result;
  }

  /**
   * Get diagnostics for a single file.
   */
  private getFileDiagnostics(filePath: string): TypeCheckDiagnostic[] {
    const syntactic = this.languageService.getSyntacticDiagnostics(filePath);
    const semantic = this.languageService.getSemanticDiagnostics(filePath);

    const result = [
      ...syntactic.map((d) => this.convertDiagnostic(d, "error")),
      ...semantic.map((d) => this.convertDiagnostic(d)),
    ];

    // Skip suggestion diagnostics if configured (faster for build-time)
    if (!this.config.skipSuggestions) {
      const suggestion = this.languageService.getSuggestionDiagnostics(filePath);
      result.push(...suggestion.map((d) => this.convertDiagnostic(d, "info")));
    }

    return result;
  }

  /**
   * Get diagnostics for all files.
   */
  private getAllDiagnostics(): TypeCheckDiagnostic[] {
    const diagnostics: TypeCheckDiagnostic[] = [];

    for (const fileName of this.getFileNames()) {
      diagnostics.push(...this.getFileDiagnostics(fileName));
    }

    return diagnostics;
  }

  /**
   * Convert a TypeScript diagnostic to our format.
   */
  private convertDiagnostic(
    diagnostic: ts.Diagnostic,
    forceSeverity?: "error" | "warning" | "info"
  ): TypeCheckDiagnostic {
    const severity =
      forceSeverity ?? this.categoryToSeverity(diagnostic.category);
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n"
    );

    let file = "";
    let line = 1;
    let column = 1;
    let endLine: number | undefined;
    let endColumn: number | undefined;

    if (diagnostic.file && diagnostic.start !== undefined) {
      file = diagnostic.file.fileName;
      const startPos = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start
      );
      line = startPos.line + 1;
      column = startPos.character + 1;

      if (diagnostic.length !== undefined) {
        const endPos = diagnostic.file.getLineAndCharacterOfPosition(
          diagnostic.start + diagnostic.length
        );
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

  /**
   * Convert TypeScript diagnostic category to severity string.
   */
  private categoryToSeverity(
    category: ts.DiagnosticCategory
  ): "error" | "warning" | "info" {
    switch (category) {
      case ts.DiagnosticCategory.Error:
        return "error";
      case ts.DiagnosticCategory.Warning:
        return "warning";
      default:
        return "info";
    }
  }

  /**
   * Get quick info (hover) for a position in a file.
   */
  getQuickInfo(
    filePath: string,
    line: number,
    column: number
  ): QuickInfo | null {
    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return null;

    const info = this.languageService.getQuickInfoAtPosition(
      filePath,
      position
    );
    if (!info) return null;

    return {
      displayParts: ts.displayPartsToString(info.displayParts),
      documentation: info.documentation
        ? ts.displayPartsToString(info.documentation)
        : undefined,
      tags: info.tags?.map((t) => ({
        name: t.name,
        text: t.text ? ts.displayPartsToString(t.text) : undefined,
      })),
    };
  }

  /**
   * Get completions at a position.
   */
  getCompletions(
    filePath: string,
    line: number,
    column: number
  ): ts.CompletionInfo | undefined {
    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return undefined;

    return this.languageService.getCompletionsAtPosition(
      filePath,
      position,
      undefined
    );
  }

  /**
   * Get definition locations for a symbol.
   */
  getDefinition(
    filePath: string,
    line: number,
    column: number
  ): readonly ts.DefinitionInfo[] | undefined {
    const position = this.getPosition(filePath, line, column);
    if (position === undefined) return undefined;

    return this.languageService.getDefinitionAtPosition(filePath, position);
  }

  /**
   * Get the program for advanced use cases.
   */
  getProgram(): ts.Program | undefined {
    return this.languageService.getProgram();
  }

  /**
   * Convert line/column to offset position.
   * Reuses the source file from the language service's program when available,
   * avoiding redundant AST parsing.
   */
  private getPosition(
    filePath: string,
    line: number,
    column: number
  ): number | undefined {
    // Try to get source file from the language service's program (already parsed)
    const program = this.languageService.getProgram();
    const sourceFile = program?.getSourceFile(filePath);

    if (sourceFile) {
      try {
        return sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
      } catch {
        // Line/column out of bounds
        return undefined;
      }
    }

    // Fallback: file not in program yet, create temporary source file
    const file = this.files.get(filePath);
    if (!file) return undefined;

    const tempSourceFile = ts.createSourceFile(
      filePath,
      file.content,
      ts.ScriptTarget.Latest,
      true
    );

    try {
      return tempSourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
    } catch {
      return undefined;
    }
  }

  /**
   * Create the TypeScript language service.
   */
  private createLanguageService(): ts.LanguageService {
    const self = this;

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.getCompilerOptions(),
      getScriptFileNames: () => [...this.files.keys()],
      getScriptVersion: (fileName) =>
        String(this.files.get(fileName)?.version ?? 0),
      getScriptSnapshot: (fileName) => {
        // Check virtual files first
        const file = this.files.get(fileName);
        if (file) return ts.ScriptSnapshot.fromString(file.content);
        // Fall back to file system for workspace packages
        if (this.isWorkspacePackagePath(fileName) && fs.existsSync(fileName)) {
          const content = fs.readFileSync(fileName, "utf-8");
          return ts.ScriptSnapshot.fromString(content);
        }
        return undefined;
      },
      getCurrentDirectory: () => this.config.panelPath,
      getDefaultLibFileName: () => "/@typescript/lib/lib.es5.d.ts",
      fileExists: (filePath) => {
        // Check virtual files first
        if (this.files.has(filePath)) return true;
        // Fall back to file system for workspace packages
        if (this.isWorkspacePackagePath(filePath)) {
          return fs.existsSync(filePath);
        }
        return false;
      },
      readFile: (filePath) => {
        // Check virtual files first
        const file = this.files.get(filePath);
        if (file) return file.content;
        // Fall back to file system for workspace packages
        if (this.isWorkspacePackagePath(filePath) && fs.existsSync(filePath)) {
          return fs.readFileSync(filePath, "utf-8");
        }
        return undefined;
      },

      // Custom module resolution
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
   * Resolve a module name according to NatStack's resolution rules.
   */
  private resolveModuleName(
    moduleName: string,
    containingFile: string,
    options: ts.CompilerOptions
  ): ts.ResolvedModuleWithFailedLookupLocations {
    const result = resolveModule(moduleName, this.resolutionConfig);

    switch (result.kind) {
      case "fs-shim":
        // Map fs imports to our virtual fs type definitions
        return {
          resolvedModule: {
            resolvedFileName: "/@workspace/virtual/fs.d.ts",
            isExternalLibraryImport: false,
            extension: ts.Extension.Dts,
          },
        };

      case "path-shim":
        // Map path imports to our virtual path type definitions
        return {
          resolvedModule: {
            resolvedFileName: "/@workspace/virtual/path.d.ts",
            isExternalLibraryImport: false,
            extension: ts.Extension.Dts,
          },
        };

      case "natstack": {
        // Check loaded @workspace/* packages (dynamically loaded from filesystem)
        const fullPkgName = `@workspace/${result.packageName}`;
        const pkgData = this.natstackPackageTypes[fullPkgName];
        if (pkgData) {
          // Extract subpath from module name (e.g., @workspace/agentic-messaging/registry -> /registry)
          const afterPkg = moduleName.slice(fullPkgName.length);
          // Convert /registry to ./registry to match package.json exports format
          const subpath = afterPkg.startsWith("/") ? "." + afterPkg : null;

          // Determine the entry file - check for subpath or use index.d.ts
          let entryFile = "index.d.ts";
          if (subpath && pkgData.subpaths[subpath]) {
            entryFile = pkgData.subpaths[subpath];
          }

          const entryPath = `/@workspace/packages/${fullPkgName}/${entryFile}`;
          if (this.files.has(entryPath)) {
            return {
              resolvedModule: {
                resolvedFileName: entryPath,
                isExternalLibraryImport: false,
                extension: ts.Extension.Dts,
              },
            };
          }
        }

        // Fallback to user's workspace packages directory when available.
        if (this.config.userWorkspacePath) {
          const workspaceResolution = this.resolveWorkspaceModule(moduleName);
          if (workspaceResolution) {
            return workspaceResolution;
          }
        }

        // Fall through to standard resolution
        break;
      }

      case "dedupe": {
        // For deduped packages, first check if we have loaded types
        const loadedTypesPath = this.findLoadedTypesEntry(moduleName);
        if (loadedTypesPath) {
          return {
            resolvedModule: {
              resolvedFileName: loadedTypesPath,
              isExternalLibraryImport: true,
              extension: ts.Extension.Dts,
            },
          };
        }

        // Try standard resolution from runtime node_modules
        if (this.resolutionConfig.runtimeNodeModules) {
          const resolved = ts.resolveModuleName(
            moduleName,
            this.resolutionConfig.runtimeNodeModules + "/index.ts",
            options,
            {
              fileExists: (p) => this.files.has(p),
              readFile: (p) => this.files.get(p)?.content,
            },
            this.getTsResolutionCache()
          );
          if (resolved.resolvedModule) {
            return resolved;
          }
        }

        // Mark for external type loading if not already loaded/pending
        const pkgName = this.extractPackageName(moduleName);
        if (pkgName && !this.loadedExternalPackages.has(pkgName)) {
          this.pendingExternalPackages.add(pkgName);
        }
        // Return unresolved - will be resolved after types are loaded
        return { resolvedModule: undefined };
      }

      case "standard":
        // Check for workspace panel/worker imports before falling back to standard
        if (this.config.userWorkspacePath) {
          const workspaceResolution = this.resolveWorkspaceModule(moduleName);
          if (workspaceResolution) {
            return workspaceResolution;
          }
        }
        // Use standard resolution
        break;
    }

    // Standard TypeScript resolution
    const resolved = ts.resolveModuleName(
      moduleName,
      containingFile,
      options,
      {
        fileExists: (p) => this.files.has(p),
        readFile: (p) => this.files.get(p)?.content,
      },
      this.getTsResolutionCache()
    );

    // If unresolved and looks like an external package, check for loaded types or mark as pending
    if (!resolved.resolvedModule && this.isBareSpecifier(moduleName)) {
      const loadedTypesPath = this.findLoadedTypesEntry(moduleName);
      if (loadedTypesPath) {
        return {
          resolvedModule: {
            resolvedFileName: loadedTypesPath,
            isExternalLibraryImport: true,
            extension: ts.Extension.Dts,
          },
        };
      }

      const pkgName = this.extractPackageName(moduleName);
      if (pkgName && !this.loadedExternalPackages.has(pkgName)) {
        this.pendingExternalPackages.add(pkgName);
      }
    }

    return resolved;
  }

  /**
   * Extract the package name from a module specifier.
   * e.g., "react" -> "react", "react/jsx-runtime" -> "react", "@types/node" -> "@types/node"
   */
  private extractPackageName(moduleName: string): string | null {
    if (moduleName.startsWith("@")) {
      // Scoped package: @scope/pkg or @scope/pkg/subpath
      const parts = moduleName.split("/");
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
      return null;
    }
    // Regular package: pkg or pkg/subpath
    return moduleName.split("/")[0] || null;
  }

  /**
   * Check if a specifier is a bare module specifier (not relative/absolute).
   */
  private isBareSpecifier(specifier: string): boolean {
    return !specifier.startsWith(".") && !specifier.startsWith("/");
  }

  /**
   * Find the entry point for loaded types of a package or subpath.
   * Handles both package-level imports (react) and subpath imports (react/jsx-runtime).
   * Results are cached to avoid O(n) scans on every resolution.
   */
  private findLoadedTypesEntry(moduleName: string): string | null {
    // Check cache first
    const cached = this.resolvedModuleCache.get(moduleName);
    if (cached !== undefined) {
      return cached;
    }

    const result = this.findLoadedTypesEntryUncached(moduleName);
    this.resolvedModuleCache.set(moduleName, result);
    return result;
  }

  /**
   * Uncached implementation of findLoadedTypesEntry.
   * Uses entry point and subpath information from TypeDefinitionLoader,
   * with fallback for packages that don't use exports field (e.g., @types/*).
   */
  private findLoadedTypesEntryUncached(moduleName: string): string | null {
    const pkgName = this.extractPackageName(moduleName);
    if (!pkgName) return null;

    // Check for types at /@types/{pkgName}/
    const basePath = `/@types/${pkgName}`;

    // Extract subpath if present (e.g., "react/jsx-runtime" -> "jsx-runtime")
    let subpath = moduleName.length > pkgName.length
      ? moduleName.slice(pkgName.length + 1) // +1 for the "/"
      : null;

    if (subpath) {
      // Strip .js/.mjs/.cjs extensions from subpath - ESM imports use .js but types are .d.ts
      // e.g., "server/mcp.js" -> "server/mcp"
      const jsExtensions = [".js", ".mjs", ".cjs", ".jsx"];
      for (const ext of jsExtensions) {
        if (subpath.endsWith(ext)) {
          subpath = subpath.slice(0, -ext.length);
          break;
        }
      }

      // First, check if we have a known subpath export from package.json exports
      const pkgSubpaths = this.externalPackageSubpaths.get(pkgName);
      if (pkgSubpaths) {
        // Try both "./" prefixed and raw subpath (exports use "./" prefix)
        const subpathFile = pkgSubpaths.get(`./${subpath}`) ?? pkgSubpaths.get(subpath);
        if (subpathFile) {
          const fullPath = `${basePath}/${subpathFile}`;
          if (this.files.has(fullPath)) {
            return fullPath;
          }
        }
      }

      // Fallback for packages without exports field (e.g., @types/react)
      // Check if a file with the subpath name exists directly
      const directFile = `${basePath}/${subpath}.d.ts`;
      if (this.files.has(directFile)) {
        return directFile;
      }

      // Try index.d.ts in subpath directory
      const indexFile = `${basePath}/${subpath}/index.d.ts`;
      if (this.files.has(indexFile)) {
        return indexFile;
      }

      return null;
    }

    // Main package import - check if we have a known entry point
    const knownEntryPoint = this.externalPackageEntryPoints.get(pkgName);
    if (knownEntryPoint) {
      const fullPath = `${basePath}/${knownEntryPoint}`;
      if (this.files.has(fullPath)) {
        return fullPath;
      }
    }

    return null;
  }

  /**
   * Resolve workspace panel/agent module imports.
   * Handles @workspace-panels/*, @workspace-agents/*, and @workspace/* packages
   * from workspace/panels/, workspace/agents/, and workspace/packages/ respectively.
   */
  private resolveWorkspaceModule(
    moduleName: string
  ): ts.ResolvedModuleWithFailedLookupLocations | null {
    const userWorkspace = this.config.userWorkspacePath;
    if (!userWorkspace) return null;

    let baseDir: string;
    let scope: string;

    if (moduleName.startsWith("@workspace-panels/")) {
      baseDir = path.join(userWorkspace, "panels");
      scope = "@workspace-panels/";
    } else if (moduleName.startsWith("@workspace-agents/")) {
      baseDir = path.join(userWorkspace, "agents");
      scope = "@workspace-agents/";
    } else if (moduleName.startsWith("@workspace/")) {
      // Shared workspace packages in workspace/packages/
      baseDir = path.join(userWorkspace, "packages");
      scope = "@workspace/";
    } else {
      return null;
    }

    // Parse: @workspace-panels/project-panel/types -> packageName=project-panel, subpath=types
    const withoutScope = moduleName.slice(scope.length);
    const slashIndex = withoutScope.indexOf("/");
    const packageName = slashIndex === -1 ? withoutScope : withoutScope.slice(0, slashIndex);
    const subpath = slashIndex === -1 ? null : withoutScope.slice(slashIndex + 1);

    const packageDir = path.join(baseDir, packageName);
    const packageJsonPath = path.join(packageDir, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
        exports?: Record<string, string | { types?: string; default?: string }>;
        types?: string;
        main?: string;
      };

      let resolvedFile: string | null = null;

      // Resolve via package.json exports
      if (packageJson.exports) {
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

      // Fallback to types/main fields if no exports match
      if (!resolvedFile && !subpath) {
        if (packageJson.types) {
          resolvedFile = path.join(packageDir, packageJson.types);
        } else if (packageJson.main) {
          resolvedFile = path.join(packageDir, packageJson.main);
        } else {
          // Try index.ts/tsx
          for (const ext of [".ts", ".tsx", ".d.ts"]) {
            const indexPath = path.join(packageDir, `index${ext}`);
            if (fs.existsSync(indexPath)) {
              resolvedFile = indexPath;
              break;
            }
          }
        }
      }

      if (resolvedFile && fs.existsSync(resolvedFile)) {
        // Use the real file path so TypeScript can resolve relative imports
        // The language service host's fileExists/readFile will handle reading from disk

        // Determine extension
        const ext = resolvedFile.endsWith(".tsx")
          ? ts.Extension.Tsx
          : resolvedFile.endsWith(".ts")
          ? ts.Extension.Ts
          : resolvedFile.endsWith(".d.ts")
          ? ts.Extension.Dts
          : ts.Extension.Ts;

        return {
          resolvedModule: {
            resolvedFileName: resolvedFile,
            isExternalLibraryImport: false,
            extension: ext,
          },
        };
      }
    } catch {
      // Failed to read/parse package.json
    }

    return null;
  }

  /**
   * Check if a file path is within the user's workspace packages directory.
   * Used to allow file system access for workspace package files during type checking.
   */
  private isWorkspacePackagePath(filePath: string): boolean {
    const userWorkspace = this.config.userWorkspacePath;
    if (!userWorkspace) return false;

    // Allow access to files within workspace/panels/, workspace/agents/, workspace/packages/
    const workspaceDirs = [
      path.join(userWorkspace, "panels"),
      path.join(userWorkspace, "agents"),
      path.join(userWorkspace, "packages"),
    ];

    return workspaceDirs.some(dir => filePath.startsWith(dir + path.sep) || filePath.startsWith(dir + "/"));
  }

  /**
   * Get the TypeScript compiler options.
   */
  private getCompilerOptions(): ts.CompilerOptions {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      isolatedModules: true,
      ...this.config.compilerOptions,
    };
  }

  /**
   * Get or create the TypeScript module resolution cache.
   */
  private getTsResolutionCache(): ts.ModuleResolutionCache {
    if (!this.tsResolutionCache) {
      this.tsResolutionCache = ts.createModuleResolutionCache(
        this.config.panelPath,
        (fileName) => fileName, // getCanonicalFileName - identity for case-sensitive
        this.getCompilerOptions()
      );
    }
    return this.tsResolutionCache;
  }

  /**
   * Invalidate the TypeScript module resolution cache.
   * Called when files change.
   */
  private invalidateTsResolutionCache(): void {
    this.tsResolutionCache = null;
  }
}

/**
 * Create a TypeCheckService for a panel/worker.
 */
export function createTypeCheckService(
  config: TypeCheckServiceConfig
): TypeCheckService {
  return new TypeCheckService(config);
}
