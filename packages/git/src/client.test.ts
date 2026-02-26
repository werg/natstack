/**
 * Tests for GitAuthError from client.ts.
 *
 * The full GitClient requires isomorphic-git and a filesystem mock,
 * so we focus on the exported GitAuthError class which is cleanly testable.
 */

import { GitAuthError } from "./client.js";

describe("GitAuthError", () => {
  it("has correct name and message", () => {
    const error = new GitAuthError("Authentication failed");
    expect(error.name).toBe("GitAuthError");
    expect(error.message).toBe("Authentication failed");
  });

  it("is an instance of Error", () => {
    const error = new GitAuthError("auth error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GitAuthError);
  });

  it("stores optional statusCode", () => {
    const errorWithCode = new GitAuthError("Forbidden", 403);
    expect(errorWithCode.statusCode).toBe(403);

    const errorWithoutCode = new GitAuthError("No code");
    expect(errorWithoutCode.statusCode).toBeUndefined();
  });
});
