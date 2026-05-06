import React, { type ComponentType, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Text } from "@radix-ui/themes";
import * as runtime from "react/jsx-runtime";

// Lazy-loaded MDX module (~200-500KB deferred until first JSX message)
let mdxModule: typeof import("@mdx-js/mdx") | null = null;
async function getMdx() {
  if (!mdxModule) {
    try { mdxModule = await import("@mdx-js/mdx"); }
    catch (e) { throw new Error(`Failed to load MDX: ${e instanceof Error ? e.message : e}`); }
  }
  return mdxModule;
}
import {
  createMdxComponents,
  markdownComponents,
  type MdxActionHandlers,
} from "./markdownComponents";

interface MessageContentProps {
  content: string;
  isStreaming: boolean;
  mdxActions?: MdxActionHandlers;
}

const remarkPlugins = [remarkGfm];

// Lazy-loaded rehype-highlight plugin (~1.5MB highlight.js deferred until first render)
type RehypeHighlightPlugin = typeof import("rehype-highlight").default;
let rehypeHighlightPlugin: RehypeHighlightPlugin | null = null;
let rehypeHighlightPromise: Promise<RehypeHighlightPlugin> | null = null;

function getRehypeHighlight(): Promise<RehypeHighlightPlugin> {
  if (rehypeHighlightPlugin) {
    return Promise.resolve(rehypeHighlightPlugin);
  }
  if (!rehypeHighlightPromise) {
    rehypeHighlightPromise = import("rehype-highlight").then((m) => {
      rehypeHighlightPlugin = m.default;
      return rehypeHighlightPlugin;
    });
  }
  return rehypeHighlightPromise;
}

async function compileMdx(
  content: string,
  rehypeHighlight: RehypeHighlightPlugin,
  mdxActions?: MdxActionHandlers,
): Promise<ComponentType | null> {
  const rehypePlugins: [RehypeHighlightPlugin, { ignoreMissing: boolean }][] = [[rehypeHighlight, { ignoreMissing: true }]];
  const { evaluate } = await getMdx();
  const { default: Component } = await evaluate(content, {
    ...runtime,
    development: false,
    useMDXComponents: (() => createMdxComponents(mdxActions)) as never,
    remarkPlugins,
    rehypePlugins,
  });
  return Component as ComponentType;
}

// Regex to detect markdown syntax that benefits from ReactMarkdown rendering.
// Must match actual syntax in context — not bare punctuation like `-`, `!`, `_`
// which appear in normal English and would defeat the plain-text fast path.
const MARKDOWN_SYNTAX_RE = /^[ \t]*#{1,6} |`[^`]|```|\*\*|__|\*[^\s*]|_[^\s_]|^[ \t]*[-*+] |^[ \t]*\d+\. |^[ \t]*>|~~|\[[^\]]*\]\(|!\[|.*\|.*\|/m;

export const MessageContent = React.memo(function MessageContent({ content, isStreaming, mdxActions }: MessageContentProps) {
  const [MdxComponent, setMdxComponent] = useState<ComponentType | null>(null);
  const [highlightLoaded, setHighlightLoaded] = useState<RehypeHighlightPlugin | null>(rehypeHighlightPlugin);

  // Lazy-load highlight.js on first render
  useEffect(() => {
    if (!rehypeHighlightPlugin) {
      void getRehypeHighlight().then(setHighlightLoaded);
    }
  }, []);

  useEffect(() => {
    if (isStreaming) {
      setMdxComponent(null);
      return;
    }

    const hasJsx = /<[A-Z]/.test(content);
    if (!hasJsx) {
      setMdxComponent(null);
      return;
    }

    // Wait for highlight.js to load before compiling MDX
    if (!highlightLoaded) return;

    let cancelled = false;

    // Try compilation
    compileMdx(content, highlightLoaded, mdxActions)
      .then((Component) => {
        if (!cancelled) setMdxComponent(() => Component);
      })
      .catch((err) => {
        if (!cancelled) {
          console.debug("MDX compilation failed, using markdown fallback:", err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [content, isStreaming, highlightLoaded, mdxActions]);

  if (MdxComponent) {
    return <MdxComponent />;
  }

  // Fast path: during streaming, if content has no markdown syntax yet,
  // skip ReactMarkdown entirely and render as plain text
  if (isStreaming && !MARKDOWN_SYNTAX_RE.test(content)) {
    return (
      <Text as="div" size="2" style={{ whiteSpace: "pre-wrap" }}>
        {content}
      </Text>
    );
  }

  // Skip syntax highlighting during streaming — code blocks are incomplete
  // and highlight.js work is wasted. Full highlighting applies on final render.
  const rehypePlugins = !isStreaming && highlightLoaded
    ? ([[highlightLoaded, { ignoreMissing: true }]] as [RehypeHighlightPlugin, { ignoreMissing: boolean }][])
    : [];

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});
