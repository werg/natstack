import { describe, expect, it } from "vitest";
import { buildFlushPayload, extractMentionsFromDiff } from "./diff";

describe("flush diff payloads", () => {
  it("returns null for identical content", () => {
    expect(buildFlushPayload({ path: "A.mdx", before: "same", after: "same", knownHandles: [] })).toBeNull();
  });

  it("counts added and removed content lines", () => {
    const payload = buildFlushPayload({
      path: "A.mdx",
      before: "one\ntwo\n",
      after: "one\nthree\nfour\n",
      knownHandles: [],
    });

    expect(payload?.addedLines).toBe(2);
    expect(payload?.removedLines).toBe(1);
    expect(payload?.unifiedDiff).toContain("+three");
  });

  it("extracts only known handles from added lines", () => {
    const payload = buildFlushPayload({
      path: "A.mdx",
      before: "@scribe old mention\n",
      after: "@scribe old mention\nPlease help @scribe and @unknown\n",
      knownHandles: ["scribe"],
    });

    expect(payload?.mentions).toEqual(["scribe"]);
  });

  it("does not confuse patch headers with content mentions", () => {
    const diff = [
      "Index: @scribe",
      "===================================================================",
      "--- A.mdx",
      "+++ A.mdx",
      "@@ -1 +1 @@",
      "+hello @scribe",
    ].join("\n");

    expect(extractMentionsFromDiff(diff, ["scribe"])).toEqual(["scribe"]);
  });
});
