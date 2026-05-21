/**
 * Live MDX preview pane.
 *
 * Compiles the document via `@mdx-js/mdx`'s `evaluate` — the same path
 * `MessageContent.tsx` from `@workspace/agentic-chat` uses for assistant
 * messages. JSX inside the document has access to:
 *
 *   - the full `mdxComponents` set (Radix Themes + Icons) from
 *     `@workspace/agentic-chat` — so `<Callout>`, `<Card>`, `<Icons.*>` etc.
 *     just work without imports
 *   - a `runtime` component (e.g. `<runtime.Eval code="…" />`) that defers
 *     to `compileComponent` from `@workspace/eval` and executes arbitrary
 *     TSX with full panel sandbox bindings (rpc, fs, GitClient, …) — the
 *     "MDX eval environment has full access to the entire runtime" goal
 *
 * Used as the read-mode counterpart to the WYSIWYG editor — toggle via the
 * editor's mode switcher.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ComponentType } from "react";
import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import * as runtime from "react/jsx-runtime";
import { spectroliteMdxComponents } from "../mdx/components";
import {
  compileComponent,
  type SandboxOptions,
} from "@workspace/eval";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { rpc } from "@workspace/runtime";

interface EvalProps {
  code: string;
  imports?: Record<string, string>;
}

const sandbox = createPanelSandboxConfig(rpc);

/**
 * Context for frontmatter-declared dependencies. `<runtime.Eval>` reads
 * from here and merges with its own per-call `imports` prop so doc-level
 * deps don't have to be redeclared inside every Eval block.
 */
const DepsContext = createContext<Record<string, string>>({});

function LiveEval({ code, imports }: EvalProps) {
  const docDeps = useContext(DepsContext);
  const mergedImports = useMemo(() => {
    const merged = { ...docDeps, ...(imports ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }, [docDeps, imports]);
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setComponent(null);
    const opts: SandboxOptions = {
      imports: mergedImports,
      loadImport: sandbox.loadImport,
    };
    void compileComponent(code, opts as Parameters<typeof compileComponent>[1]).then((result) => {
      if (cancelled) return;
      if (result.success && result.Component) {
        setComponent(() => result.Component as ComponentType);
      } else {
        setError(result.error ?? "compile failed");
      }
    });
    return () => { cancelled = true; };
  }, [code, mergedImports]);

  if (error) {
    return (
      <Card>
        <Flex align="center" gap="2">
          <ExclamationTriangleIcon color="red" />
          <Text size="1" color="red">{error}</Text>
        </Flex>
      </Card>
    );
  }
  if (!Component) {
    return <Text size="1" color="gray">Compiling…</Text>;
  }
  return <Component />;
}

const runtimeComponents = { Eval: LiveEval };

let mdxModule: typeof import("@mdx-js/mdx") | null = null;
async function getMdx() {
  if (!mdxModule) {
    mdxModule = await import("@mdx-js/mdx");
  }
  return mdxModule;
}

async function compileMdxDoc(content: string): Promise<ComponentType | null> {
  const { evaluate } = await getMdx();
  const { default: Component } = await evaluate(content, {
    ...runtime,
    development: false,
    useMDXComponents: () => ({
      ...spectroliteMdxComponents,
      runtime: runtimeComponents,
    }) as never,
  });
  return Component as ComponentType;
}

export function PreviewPane({ markdown, dependencies }: { markdown: string; dependencies?: Record<string, string> }) {
  const depsValue = dependencies ?? {};
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Memoise on markdown so recompile happens on each meaningful change
  const key = useMemo(() => markdown, [markdown]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void compileMdxDoc(key)
      .then((C) => { if (!cancelled) setComponent(() => C); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [key]);

  if (error) {
    return (
      <Box p="3">
        <Card>
          <Flex direction="column" gap="2">
            <Flex align="center" gap="2"><ExclamationTriangleIcon color="red" /><Text size="2" color="red">MDX compile failed</Text></Flex>
            <Code size="1" style={{ whiteSpace: "pre-wrap" }}>{error}</Code>
          </Flex>
        </Card>
      </Box>
    );
  }
  if (!Component) {
    return <Box p="3"><Text size="2" color="gray">Compiling preview…</Text></Box>;
  }
  return (
    <DepsContext.Provider value={depsValue}>
      <Box p="3" className="message-prose" style={{ overflowY: "auto", height: "100%" }}>
        <Component />
      </Box>
    </DepsContext.Provider>
  );
}
