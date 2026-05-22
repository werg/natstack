// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineGroup, type InlineItem } from "./InlineGroup";
import { CustomMessageCard } from "./CustomMessage";
import type { MessageTypeComponentEntry } from "../types";

type CustomInlineItem = Extract<InlineItem, { type: "custom" }>;
type ReadyMessageTypeComponentEntry = Extract<MessageTypeComponentEntry, { status: "ready" }>;

afterEach(() => {
  vi.restoreAllMocks();
});

function customItem(): CustomInlineItem {
  return {
    type: "custom",
    id: "custom-msg-1",
    payload: {
      messageId: "custom-msg-1",
      typeId: "weather",
      displayMode: "inline",
      initialState: { city: "Berlin" },
      updates: [],
      lastSeq: 1,
    },
  };
}

function customEntry(): ReadyMessageTypeComponentEntry {
  return {
    status: "ready",
    definition: {
      typeId: "weather",
      displayMode: "inline",
      source: { type: "code", code: "" },
      updatedAtSeq: 1,
    },
    cacheKey: "weather:1",
    module: {
      default: ({ expanded, displayMode }) => (
        <span>{expanded ? `expanded ${displayMode}` : `collapsed ${displayMode}`}</span>
      ),
    },
  };
}

describe("InlineGroup custom messages", () => {
  it("lets the host toggle custom renderers between collapsed and expanded views", () => {
    render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", customEntry()]])}
      />,
    );

    const collapsed = screen.getByText("collapsed inline");
    expect(collapsed).toBeTruthy();

    fireEvent.click(collapsed);

    expect(screen.queryByText("collapsed inline")).toBeNull();
    expect(screen.getByText("expanded inline")).toBeTruthy();
  });

  it("expands collapsed custom messages with Enter and Space", () => {
    const first = render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", customEntry()]])}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { expanded: false }), { key: "Enter" });
    expect(screen.getByText("expanded inline")).toBeTruthy();
    first.unmount();

    render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", customEntry()]])}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { expanded: false }), { key: " " });
    expect(screen.getByText("expanded inline")).toBeTruthy();
  });

  it("isolates render errors in custom messages to a local fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const entry = customEntry();
    entry.module.default = () => {
      throw new Error("renderer exploded");
    };

    render(
      <CustomMessageCard
        payload={customItem().payload}
        entry={entry}
        chat={{}}
        scope={{}}
        scopes={{}}
      />,
    );

    expect(screen.getByText("Custom message error: weather")).toBeTruthy();
    expect(screen.getByText("renderer exploded")).toBeTruthy();
  });

  it("isolates reducer errors before custom renderers run", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const item = customItem();
    item.payload.updates = [{ seq: 2, update: { city: "Paris" } }];
    item.payload.lastSeq = 2;
    const entry = customEntry();
    entry.module.reduce = () => {
      throw new Error("reduce exploded");
    };

    render(
      <CustomMessageCard
        payload={item.payload}
        entry={entry}
        chat={{}}
        scope={{}}
        scopes={{}}
      />,
    );

    expect(screen.getByText("Custom message error: weather")).toBeTruthy();
    expect(screen.getByText("reduce exploded")).toBeTruthy();
  });
});
