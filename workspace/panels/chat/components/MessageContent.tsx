import { type ComponentType, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { evaluate } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { markdownComponents, mdxComponents } from "./markdownComponents";

interface MessageContentProps {
  content: string;
  isStreaming: boolean;
}

const remarkPlugins = [remarkGfm];
const rehypePlugins: [typeof rehypeHighlight, { ignoreMissing: boolean }][] = [[rehypeHighlight, { ignoreMissing: true }]];

async function compileMdx(content: string): Promise<ComponentType | null> {
  const { default: Component } = await evaluate(content, {
    ...runtime,
    development: false,
    useMDXComponents: () => mdxComponents,
    remarkPlugins,
    rehypePlugins,
  });
  return Component as ComponentType;
}

export function MessageContent({ content, isStreaming }: MessageContentProps) {
  const [MdxComponent, setMdxComponent] = useState<ComponentType | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

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

    let cancelled = false;

    // Try immediately
    compileMdx(content)
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

      compileMdx(content)
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
  }, [content, isStreaming]);

  if (MdxComponent) {
    return <MdxComponent />;
  }

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}
