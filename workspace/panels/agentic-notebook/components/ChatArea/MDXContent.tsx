import { evaluate } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { useState, useEffect, useMemo } from "react";

interface MDXContentProps {
  content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: Record<string, React.ComponentType<any>>;
}

/**
 * MDXContent - Runtime MDX compiler and renderer.
 *
 * Compiles MDX content at runtime using @mdx-js/mdx's evaluate().
 * This is intentionally unguarded - MDX has full access to passed components
 * and can execute arbitrary JSX. This is desired for the LLM sandbox.
 */
// MDX compiled components accept a components prop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MDXCompiledComponent = React.ComponentType<{ components?: Record<string, React.ComponentType<any>> }>;

export function MDXContent({ content, components = {} }: MDXContentProps) {
  const [Component, setComponent] = useState<MDXCompiledComponent | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Memoize components to avoid unnecessary recompilation
  const stableComponents = useMemo(() => components, [components]);

  useEffect(() => {
    let cancelled = false;

    async function compile() {
      try {
        // evaluate() compiles and executes MDX at runtime
        // This is essentially eval() for MDX - intentionally unguarded
        // Note: development: false uses jsx/jsxs from react/jsx-runtime
        // development: true would require jsxDEV from react/jsx-dev-runtime
        const { default: MDXComponent } = await evaluate(content, {
          ...runtime,
          baseUrl: import.meta.url,
          development: false,
        });

        if (!cancelled) {
          setComponent(() => MDXComponent as MDXCompiledComponent);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setComponent(null);
        }
      }
    }

    compile();
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (error) {
    return (
      <pre
        style={{
          color: "var(--red-11)",
          background: "var(--red-a2)",
          padding: "8px",
          borderRadius: "4px",
          fontSize: "12px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        MDX Error: {error.message}
      </pre>
    );
  }

  if (!Component) {
    return (
      <span style={{ color: "var(--gray-9)", fontSize: "12px" }}>
        Compiling...
      </span>
    );
  }

  return <Component components={stableComponents} />;
}
