/**
 * Type definition loader for NatStack type checking.
 *
 * This module loads .d.ts files from node_modules directories, resolving
 * package entry points via package.json "types" fields and following imports.
 * Used by the main process TypeDefinitionService to provide types to panels.
 */

import * as fs from "fs/promises";
import * as path from "path";

/**
 * Configuration for the TypeDefinitionLoader.
 */
export interface TypeDefinitionLoaderConfig {
  /** Paths to search for node_modules (ordered by priority) */
  nodeModulesPaths: string[];
}

/**
 * Result of loading type definitions for a package.
 */
export interface LoadedTypeDefinitions {
  /** Map of file paths to their contents */
  files: Map<string, string>;
  /** The main entry point file */
  entryPoint: string | null;
  /** Any errors encountered during loading */
  errors: string[];
}

/**
 * Loads type definitions from node_modules directories.
 */
export class TypeDefinitionLoader {
  private config: TypeDefinitionLoaderConfig;

  constructor(config: TypeDefinitionLoaderConfig) {
    this.config = config;
  }

  /**
   * Load type definitions for a package.
   *
   * @param packageName - The package name (e.g., "react", "@types/node")
   * @param visitedFiles - Optional set of already-visited files (for recursive calls)
   * @returns Loaded type definitions or null if not found
   */
  async loadPackageTypes(
    packageName: string,
    visitedFiles?: Set<string>
  ): Promise<LoadedTypeDefinitions | null> {
    // Use provided set or create new one for top-level calls
    const visited = visitedFiles ?? new Set<string>();

    const result: LoadedTypeDefinitions = {
      files: new Map(),
      entryPoint: null,
      errors: [],
    };

    // Try to find the package
    const packageDir = await this.findPackageDir(packageName);
    if (!packageDir) {
      // Try @types fallback
      const typesPackage = `@types/${packageName.replace("@", "").replace("/", "__")}`;
      const typesDir = await this.findPackageDir(typesPackage);
      if (!typesDir) {
        return null;
      }
      return this.loadFromPackageDir(typesDir, result, visited);
    }

    return this.loadFromPackageDir(packageDir, result, visited);
  }

  /**
   * Find a package directory in the configured node_modules paths.
   */
  private async findPackageDir(packageName: string): Promise<string | null> {
    for (const nodeModules of this.config.nodeModulesPaths) {
      const packageDir = path.join(nodeModules, packageName);
      try {
        const stat = await fs.stat(packageDir);
        if (stat.isDirectory()) {
          return packageDir;
        }
      } catch {
        // Not found in this node_modules
      }
    }
    return null;
  }

  /**
   * Load type definitions from a package directory.
   */
  private async loadFromPackageDir(
    packageDir: string,
    result: LoadedTypeDefinitions,
    visitedFiles: Set<string>
  ): Promise<LoadedTypeDefinitions> {
    try {
      // Read package.json
      const packageJsonPath = path.join(packageDir, "package.json");
      const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(packageJsonContent) as {
        types?: string;
        typings?: string;
        main?: string;
        exports?: unknown;
      };

      // Find the types entry point
      let typesEntry = packageJson.types || packageJson.typings;

      // Check exports field for types
      if (!typesEntry && packageJson.exports) {
        typesEntry = this.extractTypesFromExports(packageJson.exports);
      }

      // Fall back to index.d.ts
      if (!typesEntry) {
        const defaultEntry = "index.d.ts";
        const defaultPath = path.join(packageDir, defaultEntry);
        try {
          await fs.access(defaultPath);
          typesEntry = defaultEntry;
        } catch {
          // No default types file
        }
      }

      if (!typesEntry) {
        result.errors.push(`No types entry found for package at ${packageDir}`);
        return result;
      }

      // Load the entry point and follow imports
      const entryPath = path.join(packageDir, typesEntry);
      result.entryPoint = entryPath;
      await this.loadTypeFile(entryPath, packageDir, result, visitedFiles);

      return result;
    } catch (error) {
      result.errors.push(`Error loading package at ${packageDir}: ${error}`);
      return result;
    }
  }

  /**
   * Extract types path from package.json exports field.
   */
  private extractTypesFromExports(exports: unknown): string | undefined {
    if (!exports || typeof exports !== "object") {
      return undefined;
    }

    const exportsObj = exports as Record<string, unknown>;

    // Check "." entry
    const mainExport = exportsObj["."];
    if (mainExport) {
      if (typeof mainExport === "string" && mainExport.endsWith(".d.ts")) {
        return mainExport;
      }
      if (typeof mainExport === "object" && mainExport !== null) {
        const entry = mainExport as Record<string, unknown>;
        // Check for types, import, or default with .d.ts
        for (const key of ["types", "import", "default"]) {
          const value = entry[key];
          if (typeof value === "string" && value.endsWith(".d.ts")) {
            return value;
          }
          // Nested condition (like "types" inside "import")
          if (typeof value === "object" && value !== null) {
            const nested = value as Record<string, unknown>;
            if (typeof nested["types"] === "string") {
              return nested["types"];
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Load a type definition file and follow its imports.
   */
  private async loadTypeFile(
    filePath: string,
    packageDir: string,
    result: LoadedTypeDefinitions,
    visitedFiles: Set<string>
  ): Promise<void> {
    // Avoid circular dependencies
    if (visitedFiles.has(filePath)) {
      return;
    }
    visitedFiles.add(filePath);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      result.files.set(filePath, content);

      // Find and follow imports
      const { imports, referenceTypes } = this.extractImports(content);
      for (const importPath of imports) {
        await this.resolveAndLoadImport(importPath, filePath, packageDir, result, visitedFiles);
      }

      // Load reference types (e.g., /// <reference types="node" />)
      for (const refType of referenceTypes) {
        await this.loadReferenceType(refType, result, visitedFiles);
      }
    } catch (error) {
      result.errors.push(`Error loading file ${filePath}: ${error}`);
    }
  }

  /**
   * Load types for a reference type directive (e.g., /// <reference types="node" />).
   */
  private async loadReferenceType(
    refType: string,
    result: LoadedTypeDefinitions,
    visitedFiles: Set<string>
  ): Promise<void> {
    // Try to load @types/{refType} from node_modules
    const typesPackage = `@types/${refType}`;
    const loaded = await this.loadPackageTypes(typesPackage, visitedFiles);
    if (loaded) {
      // Merge the loaded files into the result
      for (const [filePath, content] of loaded.files) {
        if (!result.files.has(filePath)) {
          result.files.set(filePath, content);
        }
      }
      result.errors.push(...loaded.errors);
    }
  }

  /**
   * Extract import paths and reference types from TypeScript source.
   */
  private extractImports(content: string): { imports: string[]; referenceTypes: string[] } {
    const imports: string[] = [];
    const referenceTypes: string[] = [];

    // Match: import ... from "path"
    // Match: import "path"
    // Match: export ... from "path"
    // Match: /// <reference path="..." />
    const importPatterns = [
      /import\s+(?:.*?\s+from\s+)?["']([^"']+)["']/g,
      /export\s+(?:.*?\s+from\s+)?["']([^"']+)["']/g,
      /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/g,
    ];

    for (const pattern of importPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) {
          imports.push(match[1]);
        }
      }
    }

    // Match: /// <reference types="..." /> separately
    const refTypesPattern = /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/g;
    let match;
    while ((match = refTypesPattern.exec(content)) !== null) {
      if (match[1]) {
        referenceTypes.push(match[1]);
      }
    }

    return { imports, referenceTypes };
  }

  /**
   * Resolve an import path and load the file.
   * Handles ESM-style .js/.mjs/.cjs imports by resolving to .d.ts files.
   */
  private async resolveAndLoadImport(
    importPath: string,
    fromFile: string,
    packageDir: string,
    result: LoadedTypeDefinitions,
    visitedFiles: Set<string>
  ): Promise<void> {
    // Skip bare specifiers (external packages)
    if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
      return;
    }

    const fromDir = path.dirname(fromFile);
    let resolvedPath = path.resolve(fromDir, importPath);

    // Strip ESM-style JS extensions - TypeScript resolves .js imports to .ts/.d.ts
    // This handles: import "./utils.js" -> ./utils.d.ts
    const jsExtensions = [".js", ".mjs", ".cjs", ".jsx"];
    for (const jsExt of jsExtensions) {
      if (resolvedPath.endsWith(jsExt)) {
        resolvedPath = resolvedPath.slice(0, -jsExt.length);
        break;
      }
    }

    // Try various extensions (order matters: prefer .d.ts over .ts)
    const extensions = [".d.ts", ".ts", "/index.d.ts", "/index.ts"];

    for (const ext of extensions) {
      // Skip adding extension if path already ends with .ts (but not .d.ts which we'd double)
      const tryPath = resolvedPath.endsWith(".ts") && !resolvedPath.endsWith(".d.ts")
        ? resolvedPath
        : resolvedPath + ext;
      try {
        await fs.access(tryPath);
        await this.loadTypeFile(tryPath, packageDir, result, visitedFiles);
        return;
      } catch {
        // Try next extension
      }
    }

    // File not found - might be okay for external deps
  }
}

/**
 * Create a TypeDefinitionLoader instance.
 */
export function createTypeDefinitionLoader(
  config: TypeDefinitionLoaderConfig
): TypeDefinitionLoader {
  return new TypeDefinitionLoader(config);
}

/**
 * Get standard node_modules paths for a project.
 */
export function getDefaultNodeModulesPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  let current = projectRoot;

  // Walk up the directory tree looking for node_modules
  while (current !== path.dirname(current)) {
    paths.push(path.join(current, "node_modules"));
    current = path.dirname(current);
  }

  return paths;
}
