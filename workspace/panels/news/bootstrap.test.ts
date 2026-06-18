import { describe, expect, it } from "vitest";
import {
  newsAgentKey,
  newsChannelName,
  relativeAge,
  resolveNewsContextId,
  SUGGESTED_FEEDS,
  SUGGESTED_TOPICS,
} from "./bootstrap.js";

describe("resolveNewsContextId", () => {
  it("prefers stateArgs, falls back to runtime, rejects blanks", () => {
    expect(resolveNewsContextId("ctx-a", "ctx-b")).toBe("ctx-a");
    expect(resolveNewsContextId(undefined, "ctx-b")).toBe("ctx-b");
    expect(resolveNewsContextId("  ", undefined)).toBeUndefined();
    expect(resolveNewsContextId(undefined, undefined)).toBeUndefined();
  });
});

describe("name minting", () => {
  it("derives stable prefixed names from the random source", () => {
    expect(newsChannelName(() => "abcdef1234")).toBe("news-abcdef12");
    expect(newsAgentKey(() => "abcdef1234")).toBe("news-agent-abcdef12");
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-06-18T12:00:00Z");
  it("renders compact buckets and rejects junk/future", () => {
    expect(relativeAge(undefined, now)).toBeNull();
    expect(relativeAge("not-a-date", now)).toBeNull();
    expect(relativeAge("2026-06-18T12:30:00Z", now)).toBeNull(); // future
    expect(relativeAge("2026-06-18T11:59:30Z", now)).toBe("now");
    expect(relativeAge("2026-06-18T11:30:00Z", now)).toBe("30m");
    expect(relativeAge("2026-06-18T09:00:00Z", now)).toBe("3h");
    expect(relativeAge("2026-06-16T12:00:00Z", now)).toBe("2d");
    expect(relativeAge("2026-06-04T12:00:00Z", now)).toBe("2w");
  });
});

describe("quick-start suggestions", () => {
  it("offers curated http(s) feeds and non-empty topics", () => {
    expect(SUGGESTED_FEEDS.length).toBeGreaterThan(0);
    for (const feed of SUGGESTED_FEEDS) {
      expect(feed.url).toMatch(/^https?:\/\//);
      expect(feed.label.length).toBeGreaterThan(0);
    }
    expect(SUGGESTED_TOPICS.length).toBeGreaterThan(0);
    expect(new Set(SUGGESTED_TOPICS).size).toBe(SUGGESTED_TOPICS.length);
  });
});
