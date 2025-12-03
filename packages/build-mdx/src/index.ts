/**
 * @natstack/build-mdx
 *
 * Compile MDX content to React components with OPFS import support.
 */

export {
  compileMDX,
  initializeMDX,
  MDXAbortError,
  MDXCompileError,
} from "./compile.js";

export type {
  MDXOptions,
  MDXResult,
  AnyComponent,
} from "./types.js";

// Re-export BuildError from @natstack/build for convenience
export { BuildError } from "@natstack/build";
