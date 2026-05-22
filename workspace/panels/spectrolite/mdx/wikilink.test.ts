import { describe, expect, it } from "vitest";
import { extractWikilinks, resolveWikilinkTarget, wikilinksFromJsx, wikilinksToJsx } from "./wikilink";

describe("wikilink transforms", () => {
  it("round-trips simple and aliased links", () => {
    const source = "See [[Daily Note]] and [[Projects/Roadmap|the roadmap]].";
    const jsx = wikilinksToJsx(source);

    expect(jsx).toContain('<WikiLink target="Daily Note" />');
    expect(jsx).toContain('<WikiLink target="Projects/Roadmap">the roadmap</WikiLink>');
    expect(wikilinksFromJsx(jsx)).toBe(source);
  });

  it("does not transform frontmatter or fenced code blocks", () => {
    const source = [
      "---",
      "title: \"[[Literal Title]]\"",
      "---",
      "",
      "```md",
      "[[Literal Code]]",
      "```",
      "",
      "[[Real Link]]",
    ].join("\n");

    const jsx = wikilinksToJsx(source);

    expect(jsx).toContain('title: "[[Literal Title]]"');
    expect(jsx).toContain("[[Literal Code]]");
    expect(jsx).toContain('<WikiLink target="Real Link" />');
  });

  it("does not transform CRLF frontmatter", () => {
    const source = "---\r\ntitle: \"[[Literal Title]]\"\r\n---\r\n\r\n[[Real Link]]";
    const jsx = wikilinksToJsx(source);

    expect(jsx).toContain('title: "[[Literal Title]]"');
    expect(jsx).toContain('<WikiLink target="Real Link" />');
    expect(wikilinksFromJsx(jsx)).toBe(source);
  });

  it("preserves escaped target text across a write", () => {
    const source = "[[A & B < C > D \"quoted\"]]";
    expect(wikilinksFromJsx(wikilinksToJsx(source))).toBe(source);
  });

  it("preserves escaped alias text across a write", () => {
    const source = "[[Target|A & B < C {value}]]";
    const jsx = wikilinksToJsx(source);

    expect(jsx).toContain("A &amp; B &lt; C &#123;value&#125;");
    expect(wikilinksFromJsx(jsx)).toBe(source);
  });

  it("preserves literal numeric brace entities in alias text", () => {
    const source = "[[Target|&#123;value&#125;]]";
    const jsx = wikilinksToJsx(source);

    expect(jsx).toContain("&amp;#123;value&amp;#125;");
    expect(wikilinksFromJsx(jsx)).toBe(source);
  });
});

describe("wikilink lookup", () => {
  it("resolves the shortest matching path", () => {
    expect(resolveWikilinkTarget("Today", ["archive/2025/Today.mdx", "Today.mdx"])).toBe("Today.mdx");
  });

  it("extracts raw and JSX wikilinks", () => {
    const links = extractWikilinks('[[A]] <WikiLink target="B &amp; C" /> <WikiLink target="D">Alias</WikiLink>');
    expect(links).toEqual(["A", "B & C", "D"]);
  });
});
