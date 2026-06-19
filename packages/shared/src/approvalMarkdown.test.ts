import { describe, expect, it } from "vitest";
import { parseApprovalMarkdown } from "./approvalMarkdown";

describe("approval markdown", () => {
  it("parses safe approval body formatting", () => {
    expect(parseApprovalMarkdown("Run `sudo systemctl restart natstack`.\n\n- **Gate:** plugin\n- *Reason:* deploy update"))
      .toEqual([
        {
          kind: "paragraph",
          children: [
            { kind: "text", text: "Run " },
            { kind: "code", text: "sudo systemctl restart natstack" },
            { kind: "text", text: "." },
          ],
        },
        {
          kind: "bullet-list",
          items: [
            [
              { kind: "strong", children: [{ kind: "text", text: "Gate:" }] },
              { kind: "text", text: " plugin" },
            ],
            [
              { kind: "emphasis", children: [{ kind: "text", text: "Reason:" }] },
              { kind: "text", text: " deploy update" },
            ],
          ],
        },
      ]);
  });

  it("does not interpret HTML or links as active content", () => {
    expect(parseApprovalMarkdown("<script>alert(1)</script> [open](https://example.test)"))
      .toEqual([
        {
          kind: "paragraph",
          children: [
            { kind: "text", text: "<script>alert(1)</script> [open](https://example.test)" },
          ],
        },
      ]);
  });
});
