import { describe, expect, it } from "vitest";
import { formatVcsError } from "./vcsErrors";

describe("formatVcsError", () => {
  it("explains missing VCS heads without leaking raw service output", () => {
    expect(formatVcsError("head", new Error("Unknown vcs ref: ctx:missing"))).toBe(
      "This VCS head is unavailable. Refresh the workspace or reopen this vault."
    );
  });

  it("explains incomplete VCS object stores without leaking raw CLI output", () => {
    expect(formatVcsError("status", new Error("fatal: could not find object abc123"))).toBe(
      "Workspace VCS data for this vault appears incomplete. Refresh the workspace or reopen the vault, then try again."
    );
  });

  it("uses operation-specific messages", () => {
    expect(formatVcsError("head", new Error("unexpected"))).toBe(
      "The VCS head is unavailable right now. Refresh the workspace or reopen this vault."
    );
    expect(formatVcsError("status", "unexpected")).toBe(
      "Workspace VCS status is unavailable right now. Refresh the workspace or reopen this vault."
    );
  });
});
