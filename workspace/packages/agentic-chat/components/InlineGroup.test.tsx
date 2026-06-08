// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("publishes custom.render_failed diagnostics when a renderer crashes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const publish = vi.fn().mockResolvedValue(undefined);
    const entry = customEntry();
    entry.definition.source = { type: "file", path: "panels/chat/examples/weather-message-type.tsx" };
    entry.module.default = () => {
      throw new Error("renderer exploded");
    };

    render(
      <CustomMessageCard
        payload={customItem().payload}
        entry={entry}
        chat={{ publish }}
        scope={{}}
        scopes={{}}
      />,
    );

    await waitFor(() => expect(publish).toHaveBeenCalledWith(
      "custom.render_failed",
      expect.objectContaining({
        typeId: "weather",
        messageId: "custom-msg-1",
        displayMode: "inline",
        renderer: expect.objectContaining({
          sourcePath: "panels/chat/examples/weather-message-type.tsx",
          cacheKey: "weather:1",
          updatedAtSeq: 1,
        }),
        error: expect.objectContaining({
          message: "renderer exploded",
          componentStack: expect.any(String),
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("custom:render-failed:custom-msg-1:1:expanded:weather:1"),
      }),
    ));
  });

  it("keeps prior state when a reducer throws instead of blanking the card", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const item = customItem();
    item.payload.updates = [{ seq: 2, update: { city: "Paris" } }];
    item.payload.lastSeq = 2;
    const entry = customEntry();
    // Render the folded state's city so we can prove the prior state survived.
    entry.module.default = ({ state }) => <span>city: {(state as { city?: string })?.city ?? "none"}</span>;
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

    // No error fallback; the seed state (Berlin) is preserved, Paris dropped.
    expect(screen.queryByText("Custom message error: weather")).toBeNull();
    expect(screen.getByText("city: Berlin")).toBeTruthy();
  });

  it("renders a dedicated Pill export for the collapsed inline view", () => {
    const entry = customEntry();
    entry.module.Pill = ({ expanded }) => <span>pill {expanded ? "open" : "closed"}</span>;

    render(
      <InlineGroup
        items={[customItem()]}
        messageTypeComponents={new Map([["weather", entry]])}
      />,
    );

    // Collapsed bead uses Pill, not the default component.
    expect(screen.getByText("pill closed")).toBeTruthy();
    expect(screen.queryByText("collapsed inline")).toBeNull();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    // Expanded view falls back to the default component.
    expect(screen.getByText("expanded inline")).toBeTruthy();
  });

  it("surfaces a validation callout when the schema rejects state", () => {
    const entry = customEntry();
    entry.module.schema = (state: unknown) =>
      (state as { city?: string })?.city ? null : ["missing city"];
    const item = customItem();
    item.payload.initialState = {}; // no city -> invalid

    render(
      <CustomMessageCard
        payload={item.payload}
        entry={entry}
        chat={{}}
        scope={{}}
        scopes={{}}
      />,
    );

    expect(screen.getByText("Invalid weather state")).toBeTruthy();
    expect(screen.getByText("missing city")).toBeTruthy();
  });
});
