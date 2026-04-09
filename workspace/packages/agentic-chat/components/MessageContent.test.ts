// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  MessageContent,
  ImageContentBlock,
  type ContentBlock,
  type ImageBlock,
} from "./MessageContent.js";

// Tiny 1x1 transparent PNG (base64-encoded), used as fixture data so we can
// assert the produced data: URL without lugging around real binary content.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Z6n9o0AAAAASUVORK5CYII=";

describe("MessageContent contentBlocks rendering", () => {
  it("renders text + image content blocks together", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Here is the screenshot you asked for:" },
      { type: "image", mimeType: "image/png", data: TINY_PNG_B64 },
    ];

    const { container } = render(
      React.createElement(MessageContent, {
        content: "",
        isStreaming: false,
        contentBlocks: blocks,
      }),
    );

    // Text block flows through ReactMarkdown
    expect(screen.getByText("Here is the screenshot you asked for:")).toBeTruthy();

    // Image block becomes an <img> with a data: URL using mimeType + base64 data
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
  });

  it("renders multiple image blocks in order", () => {
    const blocks: ContentBlock[] = [
      { type: "image", mimeType: "image/png", data: TINY_PNG_B64 },
      { type: "image", mimeType: "image/jpeg", data: "AAAA" },
    ];

    const { container } = render(
      React.createElement(MessageContent, {
        content: "",
        isStreaming: false,
        contentBlocks: blocks,
      }),
    );

    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]?.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
    expect(imgs[1]?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  });

  it("falls back to legacy string-content path when contentBlocks is omitted", () => {
    render(
      React.createElement(MessageContent, {
        content: "Plain markdown text",
        isStreaming: false,
      }),
    );
    expect(screen.getByText("Plain markdown text")).toBeTruthy();
  });
});

describe("ImageContentBlock type narrowing", () => {
  it("renders pi-ai canonical shape ({ mimeType, data })", () => {
    const block: ImageBlock = { type: "image", mimeType: "image/png", data: TINY_PNG_B64 };
    const { container } = render(React.createElement(ImageContentBlock, { block }));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
  });

  it("renders defensive Anthropic-style shape ({ source: { media_type, data } })", () => {
    const block: ImageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
    };
    const { container } = render(React.createElement(ImageContentBlock, { block }));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
  });

  it("returns null for unrecognised image shape (no crash)", () => {
    // url-source variant — explicitly unsupported in this codebase
    const block = {
      type: "image",
      source: { type: "url", url: "https://example.com/x.png" },
    } as unknown as ImageBlock;
    const { container } = render(React.createElement(ImageContentBlock, { block }));
    expect(container.querySelector("img")).toBeNull();
  });
});
