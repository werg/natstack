import { describe, expect, it } from "vitest";
import { buildMentionDeliveryMessage } from "./mention-delivery";

describe("buildMentionDeliveryMessage", () => {
  it("builds a direct agent mention message with the inline diff", () => {
    expect(buildMentionDeliveryMessage({
      path: "E2E.mdx",
      mentions: ["scribe", "scribe"],
      unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n",
    })).toEqual({
      mentions: ["scribe"],
      content: [
        "@scribe I just edited `E2E.mdx`. Diff:",
        "```diff",
        "@@ -1 +1 @@\n-old\n+new\n",
        "```",
      ].join("\n"),
    });
  });

  it("skips delivery when no known agents are mentioned", () => {
    expect(buildMentionDeliveryMessage({
      path: "E2E.mdx",
      mentions: [],
      unifiedDiff: "diff",
    })).toBeNull();
  });
});
