import { describe, expect, it, vi } from "vitest";
import { createShellApprovalService } from "./shellApprovalService.js";

describe("shellApprovalService", () => {
  it("accepts every approval decision exposed by the consent UI", () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestCredentialInput: vi.fn(),
        resolve: vi.fn(),
        submitClientConfig: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
      },
    });

    for (const decision of ["once", "session", "version", "repo", "deny", "dismiss"] as const) {
      expect(() => service.methods["resolve"]?.args.parse(["approval-1", decision])).not.toThrow();
    }
  });
});
