/**
 * Git Types - Repo argument specification for createChild.
 */

/**
 * Repo argument specification for createChild.
 * Can be a shorthand string or full object.
 *
 * Shorthand formats:
 * - "panels/shared" - defaults to main/master branch
 * - "panels/shared#develop" - specific branch
 * - "panels/shared@v1.0.0" - specific tag
 * - "panels/shared@abc123" - specific commit (7+ hex chars)
 */
export type RepoArgSpec =
  | string
  | {
      repo: string;
      ref?: string;
    };

/**
 * Normalized repo arg after parsing shorthand
 */
export interface NormalizedRepoArg {
  name: string;
  repo: string;
  ref?: string;
  resolvedUrl: string;
  localPath: string;
}
