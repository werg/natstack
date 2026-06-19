import { describe, expect, it } from "vitest";
import { userlandApprovalRequestSchema, userlandApprovalSubjectIdSchema } from "./approvals.js";

const validRequest = {
  subject: { id: "team-x:foo", label: "Team X foo" },
  title: "Allow foo?",
  options: [
    { value: "allow", label: "Allow", tone: "primary" },
    { value: "deny", label: "Deny", tone: "danger" },
  ],
};

describe("userland approval validation", () => {
  it("accepts default scoped prompts without custom options", () => {
    expect(
      userlandApprovalRequestSchema.parse({
        subject: { id: "team-x:foo", label: "Team X foo" },
        title: "Allow foo?",
      })
    ).toEqual({
      subject: { id: "team-x:foo", label: "Team X foo" },
      title: "Allow foo?",
    });
  });

  it("strips zero-width characters before reserved-prefix and duplicate checks", () => {
    expect(() => userlandApprovalSubjectIdSchema.parse("shell\u200B:foo")).toThrow(/reserved/);
    expect(() => userlandApprovalRequestSchema.parse({
      ...validRequest,
      options: [
        { value: "allow", label: "Allow" },
        { value: "al\u200Blow", label: "Allow again" },
      ],
    })).toThrow(/unique/);
  });

  it("rejects control characters, invalid identifiers, and reserved option values", () => {
    expect(() => userlandApprovalRequestSchema.parse({ ...validRequest, title: "bad\u0001title" }))
      .toThrow(/control/);
    expect(() => userlandApprovalSubjectIdSchema.parse("bad subject")).toThrow(/invalid/);
    expect(() => userlandApprovalRequestSchema.parse({
      ...validRequest,
      options: [{ value: "dismiss", label: "Dismiss" }],
    })).toThrow(/reserved/);
  });

  it("returns sanitized strings for callers to enqueue and persist", () => {
    const parsed = userlandApprovalRequestSchema.parse({
      ...validRequest,
      subject: { id: "team\u200B-x:foo", label: "Team\u200B X" },
    });

    expect(parsed.subject).toEqual({ id: "team-x:foo", label: "Team X" });
  });

  it("accepts dangerous-action metadata and positive evidence", () => {
    expect(
      userlandApprovalRequestSchema.parse({
        subject: { id: "team-x:danger" },
        title: "Run privileged command",
        severity: "dangerous",
        defaultAction: "deny",
        positiveEvidence: [{ label: "Gate", value: "sudoers" }],
      })
    ).toMatchObject({
      severity: "dangerous",
      defaultAction: "deny",
      positiveEvidence: [{ label: "Gate", value: "sudoers" }],
    });
  });
});
