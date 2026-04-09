import React, { type ComponentType, useEffect, useRef, useState } from "react";
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
import { markdownComponents, mdxComponents } from "./markdownComponents";

// ---------------------------------------------------------------------------
// Content block rendering (pi-ai ImageContent + TextContent)
// ---------------------------------------------------------------------------

/**
 * A pi-ai content block (text or image), as it appears inside a Pi
 * `AgentMessage.content` array. We accept both the canonical pi-ai shape
 * (`{ type: "image", mimeType, data }`) and a defensive Anthropic-style
 * `source` shape (`{ type: "image", source: { media_type, data } }`) so the
 * renderer keeps working if a tool result ever passes the alternate form
 * through unchanged.
 */
export interface TextBlock {
  type: "text";
  text: string;
}

interface ImageBlockSimple {
  type: "image";
  mimeType: string;
  data: string;
}

interface ImageBlockSource {
  type: "image";
  source: {
    type?: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type ImageBlock = ImageBlockSimple | ImageBlockSource;
export type ContentBlock = TextBlock | ImageBlock | { type: string; [key: string]: unknown };

/** Extract `{ mimeType, data }` from either supported image-content shape. */
function readImageBlock(block: ImageBlock): { mimeType: string; data: string } | null {
  // pi-ai canonical shape: { type: "image", mimeType, data }
  if ("mimeType" in block && "data" in block && typeof block.mimeType === "string" && typeof block.data === "string") {
    return { mimeType: block.mimeType, data: block.data };
  }
  // Defensive Anthropic-style: { source: { media_type, data } } — base64 only.
  if ("source" in block && block.source && typeof block.source === "object") {
    const media = block.source.media_type;
    const data = block.source.data;
    // We deliberately do not handle source.type === "url" — pi-ai's read tool
    // only emits base64 images in this codebase.
    if (typeof media === "string" && typeof data === "string") {
      return { mimeType: media, data };
    }
  }
  return null;
}

/**
 * Render a single pi-ai `ImageContent` block as an `<img>` tag with size
 * capping. Used inline by both MessageContent (assistant text+image streams)
 * and tool-result renderers that may receive base64 images from the read tool.
 */
export function ImageContentBlock({ block, alt }: { block: ImageBlock; alt?: string }) {
  const parsed = readImageBlock(block);
  if (!parsed) return null;
  return (
    <img
      src={`data:${parsed.mimeType};base64,${parsed.data}`}
      alt={alt ?? "image"}
      className="max-w-full rounded"
      style={{ maxWidth: "100%", maxHeight: 400, borderRadius: "var(--radius-2)", display: "block" }}
    />
  );
}

interface MessageContentProps {
  /** Plain-text/markdown content (legacy single-string path). */
  content: string;
  isStreaming: boolean;
  /**
   * Optional pi-ai content block array. When provided, MessageContent
   * renders text blocks via the markdown pipeline and image blocks via
   * `ImageContentBlock`, ignoring the `content` string. When omitted,
   * the legacy string-based render path is used unchanged.
   */
  contentBlocks?: ReadonlyArray<ContentBlock>;
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
  const { evaluate } = await getMdx();
  const { default: Component } = await evaluate(content, {
    ...runtime,
    development: false,
    useMDXComponents: (() => mdxComponents) as never,
    remarkPlugins,
    rehypePlugins,
  });
  return Component as ComponentType;
}

// Regex to detect markdown syntax that benefits from ReactMarkdown rendering.
// Must match actual syntax in context — not bare punctuation like `-`, `!`, `_`
// which appear in normal English and would defeat the plain-text fast path.
const MARKDOWN_SYNTAX_RE = /^[ \t]*#{1,6} |`[^`]|```|\*\*|__|\*[^\s*]|_[^\s_]|^[ \t]*[-*+] |^[ \t]*\d+\. |^[ \t]*>|~~|\[[^\]]*\]\(|!\[|.*\|.*\|/m;

// Debounce interval for streaming content updates (ms)
const STREAMING_DEBOUNCE_MS = 100;

export const MessageContent = React.memo(function MessageContent({ content, isStreaming, contentBlocks }: MessageContentProps) {
  const [MdxComponent, setMdxComponent] = useState<ComponentType | null>(null);
  const [highlightLoaded, setHighlightLoaded] = useState<RehypeHighlightPlugin | null>(rehypeHighlightPlugin);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Debounced content for streaming: batch rapid content updates to reduce
  // ReactMarkdown re-parse frequency from ~10+/sec to ~10/sec max
  const [displayContent, setDisplayContent] = useState(content);
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      // Not streaming — show exact content immediately (final render)
      setDisplayContent(content);
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      return;
    }

    // During streaming, batch updates at STREAMING_DEBOUNCE_MS intervals.
    // IMPORTANT: No cleanup function here — the timer must persist across
    // content changes so that intermediate chunks are skipped. The timer
    // reads the latest content via contentRef when it fires.
    if (!streamTimerRef.current) {
      // First update in this batch — show immediately for responsiveness
      setDisplayContent(content);
      streamTimerRef.current = setTimeout(() => {
        streamTimerRef.current = null;
        // Flush latest content when timer fires
        setDisplayContent(contentRef.current);
      }, STREAMING_DEBOUNCE_MS);
    }
    // If timer is already running, the next flush will pick up contentRef.current
  }, [content, isStreaming]);

  // Cleanup timer on unmount only
  useEffect(() => {
    return () => {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
  }, []);

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Try compilation
    compileMdx(content, highlightLoaded)
      .then((Component) => {
        if (!cancelled) setMdxComponent(() => Component);
      })
      .catch((err) => {
        // Retry once after delay if compilation fails (content may still be settling)
        retryTimer = setTimeout(() => {
          if (cancelled || contentRef.current !== content) return;

          compileMdx(content, highlightLoaded)
            .then((Component) => {
              if (!cancelled) setMdxComponent(() => Component);
            })
            .catch((retryErr) => {
              console.debug("MDX compilation failed after retry, using markdown fallback:", retryErr);
            });
        }, 150);
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [content, isStreaming, highlightLoaded]);

  // ---------------------------------------------------------------------
  // Block-array path: when callers pass a pi-ai content block array we
  // render text + image blocks together. Bypasses MDX / streaming-debounce
  // because block arrays come from already-finalised Pi messages. Placed
  // after all hook calls to comply with React's rules of hooks.
  // ---------------------------------------------------------------------
  if (contentBlocks && contentBlocks.length > 0) {
    return (
      <>
        {contentBlocks.map((block, i) => {
          if (block.type === "text" && typeof (block as TextBlock).text === "string") {
            return (
              <ReactMarkdown
                key={`text-${i}`}
                remarkPlugins={remarkPlugins}
                components={markdownComponents}
              >
                {(block as TextBlock).text}
              </ReactMarkdown>
            );
          } else if (block.type === "image") {
            return <ImageContentBlock key={`img-${i}`} block={block as ImageBlock} />;
          }
          return null;
        })}
      </>
    );
  }

  if (MdxComponent) {
    return <MdxComponent />;
  }

  // Fast path: during streaming, if content has no markdown syntax yet,
  // skip ReactMarkdown entirely and render as plain text
  if (isStreaming && !MARKDOWN_SYNTAX_RE.test(displayContent)) {
    return (
      <Text as="div" size="2" style={{ whiteSpace: "pre-wrap" }}>
        {displayContent}
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
      {displayContent}
    </ReactMarkdown>
  );
});
