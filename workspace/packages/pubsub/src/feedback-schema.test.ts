import { describe, expect, it } from "vitest";
import { FeedbackFormArgsSchema } from "./protocol-schemas.js";

const baseFeedbackForm = {
  title: "Confirm",
  fields: [
    { key: "choice", label: "Choice", type: "string" },
  ],
};

describe("FeedbackFormArgsSchema", () => {
  it("accepts supported feedback form arguments", () => {
    const parsed = FeedbackFormArgsSchema.safeParse({
      ...baseFeedbackForm,
      values: { choice: "yes" },
      submitLabel: "Continue",
      cancelLabel: "Cancel",
      severity: "info",
      hideSubmit: false,
      hideCancel: false,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects timeout arguments", () => {
    const parsed = FeedbackFormArgsSchema.safeParse({
      ...baseFeedbackForm,
      timeout: 10_000,
      timeoutAction: "submit",
    });

    expect(parsed.success).toBe(false);
  });
});
