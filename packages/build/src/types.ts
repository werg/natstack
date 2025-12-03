/**
 * Shared Types for @natstack/build
 */

/**
 * Error thrown when build/transform fails.
 */
export class BuildError extends Error {
  constructor(
    message: string,
    public readonly errors: BuildErrorDetail[] = []
  ) {
    super(message);
    this.name = "BuildError";
  }
}

export interface BuildErrorDetail {
  message: string;
  file?: string;
  line?: number;
  column?: number;
}
