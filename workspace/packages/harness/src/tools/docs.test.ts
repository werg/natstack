import { describe, expect, it } from "vitest";
import { renderEntry, type CatalogEntry } from "./docs.js";

describe("renderEntry (readable docs_open text)", () => {
  it("renders a readable signature instead of a raw JSON-schema dump", () => {
    const entry: CatalogEntry = {
      id: "service:blobstore.getText",
      surface: "service",
      qualifiedName: "blobstore.getText",
      title: "blobstore.getText",
      description: "Full UTF-8 text of a blob, or null if absent.",
      access: { sensitivity: "read", callers: ["panel", "do"] },
      argsSchema: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: [{ type: "string", pattern: "^[0-9a-f]{64}$" }],
      },
      returnsSchema: { type: "string", nullable: true },
      examples: [{ args: ["e3b0c4"] }],
    };
    const text = renderEntry(entry);

    expect(text).toContain("blobstore.getText(string /^[0-9a-f]{64}$/) → string | null");
    expect(text).toContain("Full UTF-8 text of a blob");
    expect(text).toContain("Sensitivity: read");
    expect(text).toContain('blobstore.getText("e3b0c4")'); // readable example call
    // the raw JSON-schema dump is gone
    expect(text).not.toContain("Args schema:");
    expect(text).not.toContain('"type": "array"');
  });

  it("renders object args with field types, optional markers, and field docs", () => {
    const entry: CatalogEntry = {
      id: "service:feeds.add",
      surface: "service",
      qualifiedName: "feeds.add",
      title: "feeds.add",
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: {
              feedId: { type: "string", description: "the feed id" },
              limit: { type: "integer" },
            },
            required: ["feedId"],
          },
        ],
      },
    };
    const text = renderEntry(entry);
    expect(text).toContain("feeds.add({ feedId: string; limit?: integer })");
    expect(text).toContain(".feedId: string — the feed id");
  });

  it("shows the raw rpc.call form for service methods", () => {
    const entry: CatalogEntry = {
      id: "service:workers.listSources",
      surface: "service",
      qualifiedName: "workers.listSources",
      title: "workers.listSources",
      argsSchema: {
        type: "array",
        minItems: 0,
        maxItems: 0,
        items: [],
      },
    };
    const text = renderEntry(entry);

    expect(text).toContain('await rpc.call("main", "workers.listSources", [])');
    expect(text).toContain("services.<name>");
    expect(text).toContain("ergonomic runtime client");
  });
});
