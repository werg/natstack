import { describe, expect, it } from "vitest";
import { formatGitError } from "./gitErrors";

describe("formatGitError", () => {
  it("gives branch recovery guidance for dirty checkout failures", () => {
    expect(formatGitError("checkout", new Error("Your local changes would be overwritten by checkout"))).toBe(
      "Commit or discard changes before switching branches."
    );
  });

  it("explains incomplete git object stores without leaking raw CLI output", () => {
    expect(formatGitError("status", new Error("fatal: could not find object abc123"))).toBe(
      "Git data for this vault appears incomplete. Refresh the workspace or reopen the vault, then try again."
    );
  });

  it("guides users to configure identity for commit failures", () => {
    expect(formatGitError("commit", new Error("Author identity unknown"))).toBe(
      "Git needs an author name and email before it can commit. Configure your git identity, then try again."
    );
  });

  it("uses operation-specific fallbacks", () => {
    expect(formatGitError("branches", new Error("unexpected"))).toBe(
      "Branches are unavailable right now. Refresh the workspace or reopen this vault."
    );
    expect(formatGitError("commit", "unexpected")).toBe(
      "Commit failed. Check that the vault has changes and git is configured, then try again."
    );
  });
});
