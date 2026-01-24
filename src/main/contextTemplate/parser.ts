/**
 * Context Template YAML Parsing and Git Spec Parsing
 *
 * Handles parsing of context-template.yml files and git spec shorthand formats.
 */

import * as fs from "fs";
import * as path from "path";
import YAML from "yaml";
import type {
  ContextTemplateYaml,
  GitSpec,
  ParsedGitSpec,
  PathValidationError,
} from "./types.js";
import { PathValidationError as PathValidationErrorClass } from "./types.js";

/** Name of the template configuration file */
export const TEMPLATE_FILE_NAME = "context-template.yml";

/**
 * Parse a git spec shorthand into its components.
 *
 * Formats supported:
 * - "path/to/repo" -> { repo: "path/to/repo", ref: undefined }
 * - "path/to/repo#branch" -> { repo: "path/to/repo", ref: "branch" }
 * - "path/to/repo@v1.0.0" -> { repo: "path/to/repo", ref: "v1.0.0" }
 * - "path/to/repo@abc1234" -> { repo: "path/to/repo", ref: "abc1234" }
 *
 * @param spec - The git spec string to parse
 * @returns Parsed components
 */
export function parseGitSpec(spec: GitSpec): ParsedGitSpec {
  // Check for branch reference (#)
  const branchMatch = spec.match(/^(.+)#(.+)$/);
  if (branchMatch && branchMatch[1] && branchMatch[2]) {
    return {
      repo: branchMatch[1],
      ref: branchMatch[2],
      isCommitHash: false, // # always indicates a branch
    };
  }

  // Check for tag/commit reference (@)
  const refMatch = spec.match(/^(.+)@(.+)$/);
  if (refMatch && refMatch[1] && refMatch[2]) {
    const ref = refMatch[2];
    return {
      repo: refMatch[1],
      ref,
      isCommitHash: isCommitHash(ref),
    };
  }

  return {
    repo: spec,
    ref: undefined,
    isCommitHash: false,
  };
}

/**
 * Check if a ref string appears to be a commit hash.
 * Commit hashes are 7-40 lowercase hex characters.
 *
 * @param ref - The ref string to check
 * @returns true if the ref looks like a commit hash
 */
export function isCommitHash(ref?: string): boolean {
  return !!ref && /^[0-9a-f]{7,40}$/i.test(ref);
}

/**
 * Validate a target path for security.
 * Ensures the path doesn't escape the base directory through traversal,
 * absolute paths, or Windows drive letters.
 *
 * @param targetPath - The target path from the template structure
 * @param baseDir - The base directory paths are resolved against
 * @returns The validated, resolved absolute path
 * @throws PathValidationError if the path is invalid
 */
export function validateTargetPath(targetPath: string, baseDir: string): string {
  // Reject Windows drive letters (defensive, check before any path ops)
  if (/^[a-zA-Z]:/.test(targetPath)) {
    throw new PathValidationErrorClass(targetPath, "Drive letters not allowed");
  }

  // Normalize the path: treat leading / as root-relative within the context scope
  // This allows YAML paths like "/deps/foo" to match OPFS paths "/deps/foo"
  const normalizedPath = targetPath.startsWith("/") ? targetPath.slice(1) : targetPath;

  // Resolve against base and check it stays within base
  const resolved = path.resolve(baseDir, normalizedPath);
  const relative = path.relative(baseDir, resolved);

  // If relative path starts with '..' or is absolute, it escapes baseDir
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PathValidationErrorClass(targetPath, "Path escapes base directory");
  }

  // Return the safe resolved path
  return resolved;
}

/**
 * Recursively flatten a structure object into path -> gitSpec mappings.
 *
 * Supports both flat and nested formats:
 * - Flat: { "/deps/code-editor": "panels/code-editor" }
 * - Nested: { deps: { "code-editor": "panels/code-editor" } }
 * - Mixed: { "/deps/foo": "repo/foo", other: { bar: "repo/bar" } }
 *
 * Nested keys are joined with "/" to form the full path.
 *
 * @param obj - The structure object to flatten
 * @param prefix - Current path prefix (used during recursion)
 * @param result - The result object to populate
 */
function flattenStructure(
  obj: Record<string, unknown>,
  prefix: string,
  result: Record<string, GitSpec>
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key.length === 0) {
      throw new Error("Template structure path segment cannot be empty");
    }

    // Build the full path
    // If the key starts with "/", treat it as an absolute path (ignore prefix)
    // Otherwise, join with the prefix
    let fullPath: string;
    if (key.startsWith("/")) {
      fullPath = key;
    } else if (prefix) {
      fullPath = `${prefix}/${key}`;
    } else {
      fullPath = `/${key}`;
    }

    if (typeof value === "string") {
      // Leaf node: this is a git spec
      result[fullPath] = value;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Nested object: recurse with updated prefix
      flattenStructure(value as Record<string, unknown>, fullPath, result);
    } else {
      throw new Error(
        `Template structure value for "${fullPath}" must be a git spec string or nested object`
      );
    }
  }
}

/**
 * Parse a context-template.yml file.
 *
 * @param content - The YAML content to parse
 * @returns Parsed template object
 * @throws Error if the YAML is invalid or doesn't match expected schema
 */
export function parseTemplateYaml(content: string): ContextTemplateYaml {
  const parsed = YAML.parse(content);

  if (parsed === null || parsed === undefined) {
    // Empty file is valid - returns empty template
    return {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Template must be a YAML object");
  }

  const template: ContextTemplateYaml = {};

  // Validate and extract name
  if ("name" in parsed) {
    if (typeof parsed.name !== "string") {
      throw new Error("Template 'name' must be a string");
    }
    template.name = parsed.name;
  }

  // Validate and extract description
  if ("description" in parsed) {
    if (typeof parsed.description !== "string") {
      throw new Error("Template 'description' must be a string");
    }
    template.description = parsed.description;
  }

  // Validate and extract extends
  if ("extends" in parsed) {
    if (typeof parsed.extends !== "string") {
      throw new Error("Template 'extends' must be a git spec string");
    }
    template.extends = parsed.extends;
  }

  // Validate and extract structure
  if ("structure" in parsed) {
    if (typeof parsed.structure !== "object" || parsed.structure === null || Array.isArray(parsed.structure)) {
      throw new Error("Template 'structure' must be an object mapping paths to git specs");
    }

    const structure: Record<string, GitSpec> = {};

    // Recursively flatten nested structure into path -> gitSpec mappings
    flattenStructure(parsed.structure, "", structure);

    template.structure = structure;
  }

  return template;
}

/**
 * Load a context-template.yml file from a directory.
 *
 * @param dirPath - Directory containing the template file
 * @returns Parsed template, or empty template if file doesn't exist
 */
export function loadTemplateFromDir(dirPath: string): ContextTemplateYaml {
  const templatePath = path.join(dirPath, TEMPLATE_FILE_NAME);

  if (!fs.existsSync(templatePath)) {
    return {}; // Empty template if file doesn't exist
  }

  const content = fs.readFileSync(templatePath, "utf-8");
  return parseTemplateYaml(content);
}

/**
 * Check if a directory contains a context-template.yml file.
 *
 * @param dirPath - Directory to check
 * @returns true if the template file exists
 */
export function hasTemplateFile(dirPath: string): boolean {
  const templatePath = path.join(dirPath, TEMPLATE_FILE_NAME);
  return fs.existsSync(templatePath);
}

/**
 * Validate all structure paths in a template against a base directory.
 * This should be called before building a template.
 *
 * @param template - The template to validate
 * @param baseDir - Base directory to validate paths against
 * @throws PathValidationError if any path is invalid
 */
export function validateTemplateStructure(
  template: ContextTemplateYaml,
  baseDir: string
): void {
  if (!template.structure) {
    return;
  }

  for (const targetPath of Object.keys(template.structure)) {
    validateTargetPath(targetPath, baseDir);
  }
}

/**
 * Reconstruct a git spec string from parsed components.
 *
 * @param repo - Repository path
 * @param ref - Optional ref (branch/tag/commit)
 * @param useHashNotation - Use # for branches (default: false, uses @)
 * @returns Git spec string
 */
export function formatGitSpec(
  repo: string,
  ref?: string,
  useHashNotation = false
): GitSpec {
  if (!ref) {
    return repo;
  }

  const separator = useHashNotation ? "#" : "@";
  return `${repo}${separator}${ref}`;
}
