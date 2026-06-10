import { describe, expect, it } from "vitest";
import {
  defaultAttentionRules,
  evaluateAttentionRules,
  fromDomain,
  parseActionsJson,
  slug,
  validateAttentionRules,
  type GmailAttentionEvent,
} from "./rules.js";

function event(overrides: Partial<GmailAttentionEvent> = {}): GmailAttentionEvent {
  return {
    threadId: "thr-1",
    from: "Alice <a@vip.example>",
    to: "me@example.com",
    subject: "Quarterly invoice",
    snippet: "Please find attached",
    labels: ["INBOX", "UNREAD"],
    hasAttachment: false,
    unread: true,
    inInbox: true,
    addressedToUser: true,
    ...overrides,
  };
}

describe("attention rules", () => {
  it("slugs and extracts domains", () => {
    expect(slug("My Rule! 1")).toBe("my-rule-1");
    expect(fromDomain("Alice <a@VIP.Example>")).toBe("vip.example");
  });

  it("validates and normalizes rule sets", () => {
    const ruleSet = validateAttentionRules({
      version: 1,
      directives: [
        {
          id: "VIP Domain",
          name: "  VIP  ",
          match: { any: [{ field: "fromDomain", op: "equals", value: "vip.example" }] },
          actions: ["surface", "bogus"],
          priority: 5000,
        },
      ],
    });
    expect(ruleSet.directives[0]).toMatchObject({
      id: "vip-domain",
      name: "VIP",
      enabled: true,
      scope: "snippet",
      priority: 1000,
      actions: ["surface"],
    });
  });

  it("rejects invalid rule sets", () => {
    expect(() => validateAttentionRules({ version: 2, directives: [] })).toThrow("version");
    expect(() =>
      validateAttentionRules({
        version: 1,
        directives: [{ id: "x", match: {} }],
      })
    ).toThrow("requires any or all");
    expect(() =>
      validateAttentionRules({
        version: 1,
        directives: [{ id: "x", match: { any: [{ field: "subject" }] } }],
      })
    ).toThrow("requires value");
  });

  it("default rules wake only for prior-reply senders in the unread inbox", () => {
    const rules = defaultAttentionRules();
    expect(evaluateAttentionRules(rules, event()).wake).toBe(false);
    expect(
      evaluateAttentionRules(rules, event({ priorReplyToSender: true }))
    ).toMatchObject({ wake: true, directiveId: "prior-replies" });
    expect(
      evaluateAttentionRules(rules, event({ priorReplyToSender: true, labels: ["INBOX"] })).wake
    ).toBe(false);
  });

  it("evaluates any/all/not matchers and prefers higher priority", () => {
    const rules = validateAttentionRules({
      version: 1,
      directives: [
        {
          id: "low",
          match: { any: [{ field: "wakeAll", op: "present" }] },
          priority: 1,
        },
        {
          id: "high",
          match: {
            all: [{ field: "subject", op: "contains", value: "invoice" }],
            not: [{ field: "label", op: "contains", value: "SPAM" }],
          },
          priority: 100,
        },
      ],
    });
    expect(evaluateAttentionRules(rules, event())).toMatchObject({ directiveId: "high" });
    expect(
      evaluateAttentionRules(rules, event({ labels: ["INBOX", "SPAM"] }))
    ).toMatchObject({ directiveId: "low" });
  });

  it("skips disabled directives", () => {
    const rules = validateAttentionRules({
      version: 1,
      directives: [
        { id: "off", enabled: false, match: { any: [{ field: "wakeAll", op: "present" }] } },
      ],
    });
    expect(evaluateAttentionRules(rules, event()).wake).toBe(false);
  });

  it("parses stored action lists defensively", () => {
    expect(parseActionsJson('["surface","draft","bogus"]')).toEqual(["surface", "draft"]);
    expect(parseActionsJson("not json")).toEqual(["surface"]);
  });
});
