import { type ComponentType, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { evaluate } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { markdownComponents, mdxComponents } from "./markdownComponents";

interface MessageContentProps {
  content: string;
  isStreaming: boolean;
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

async function compileMdx(content: string, rehypeHighlight: RehypeHighlightPlugin): Promise<ComponentType | null> {
  const rehypePlugins: [RehypeHighlightPlugin, { ignoreMissing: boolean }][] = [[rehypeHighlight, { ignoreMissing: true }]];
  const { default: Component } = await evaluate(content, {
    ...runtime,
    development: false,
    useMDXComponents: (() => mdxComponents) as never,
    remarkPlugins,
    rehypePlugins,
  });
  return Component as ComponentType;
}

export function MessageContent({ content, isStreaming }: MessageContentProps) {
  const [MdxComponent, setMdxComponent] = useState<ComponentType | null>(null);
  const [highlightLoaded, setHighlightLoaded] = useState<RehypeHighlightPlugin | null>(rehypeHighlightPlugin);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Lazy-load highlight.js on first render
  useEffect(() => {
    if (!highlightLoaded) {
      void getRehypeHighlight().then(setHighlightLoaded);
    }
  }, [highlightLoaded]);

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

    // Try immediately
    compileMdx(content, highlightLoaded)
      .then((Component) => {
        if (!cancelled) setMdxComponent(() => Component);
      })
      .catch(() => {
        // Immediate attempt failed, will retry with delay
      });

    // Retry after delay (in case content settles)
    const timer = setTimeout(() => {
      if (cancelled) return;
      // Only retry if content hasn't changed
      if (contentRef.current !== content) return;

      compileMdx(content, highlightLoaded)
        .then((Component) => {
          if (!cancelled) setMdxComponent(() => Component);
        })
        .catch((err) => {
          console.debug("MDX compilation failed, using markdown fallback:", err);
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content, isStreaming, highlightLoaded]);

  if (MdxComponent) {
    return <MdxComponent />;
  }

  // Render markdown - with or without syntax highlighting depending on load state
  const rehypePlugins = highlightLoaded
    ? ([[highlightLoaded, { ignoreMissing: true }]] as [RehypeHighlightPlugin, { ignoreMissing: boolean }][])
    : [];

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}
