// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Participant } from "@workspace/pubsub";
import { useMentionAutocomplete } from "./useMentionAutocomplete";
import type { ChatParticipantMetadata } from "../types";

const roster = {
  "panel:user": { id: "panel:user", metadata: { name: "Chat Panel", type: "panel", handle: "user" } },
  "agent:ai": { id: "agent:ai", metadata: { name: "AI Chat", type: "agent", handle: "ai-chat" } },
} as unknown as Record<string, Participant<ChatParticipantMetadata>>;

describe("useMentionAutocomplete", () => {
  it("excludes the client's own participant (you can't @-mention the chat panel itself)", () => {
    const { result } = renderHook(() => useMentionAutocomplete(roster, "panel:user"));
    expect(result.current.candidates.map((c) => c.handle)).toEqual(["ai-chat"]);
  });

  it("includes everyone when no selfId is given", () => {
    const { result } = renderHook(() => useMentionAutocomplete(roster));
    expect(result.current.candidates.map((c) => c.handle).sort()).toEqual(["ai-chat", "user"]);
  });
});
