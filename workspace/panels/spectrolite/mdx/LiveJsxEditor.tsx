/**
 * Live JSX editor — replaces `GenericJsxEditor` for every JSX descriptor.
 *
 * MDXEditor's JSX descriptor `Editor` receives the mdast node of the JSX
 * element. We serialize the full subtree (including nested JSX, paragraphs,
 * lists, etc.) back to MDX source via `mdast-util-to-markdown` +
 * `mdast-util-mdx-jsx`, then compile-and-render it via `compileComponent`
 * with `createPanelSandboxConfig(rpc)` bindings — so live JSX in the
 * document has full access to the panel runtime (rpc, fs, GitClient, …),
 * which is the "MDX eval environment with full runtime access" goal.
 *
 * Works for the wildcard `name: "*"` descriptor too: we read the actual
 * tag name from `mdastNode.name` rather than `descriptor.name`.
 *
 * Doc-level exports + the `runtime` namespace are pulled in via
 * globalThis backdoors set by `DocumentEditor`:
 *
 *   - `globalThis.__spectroliteUseDocState__` — useDocState hook
 *   - `globalThis.__spectroliteRuntime__`     — `runtime.Eval`, etc.
 *   - `globalThis.__spectroliteDocExports__`  — named exports from the
 *      whole-doc compile, so `<Counter />` (defined as
 *      `export const Counter = …` elsewhere in the same doc) resolves.
 *
 * The per-node compile depends on:
 *   - the serialized JSX source for this node
 *   - the list of currently-known doc export NAMES (so the wrapper
 *     destructures the right identifiers — body changes don't require
 *     recompiling the wrapper string but do require re-rendering)
 *   - the `docExportsVersion` counter from `DocumentEditor`, bumped
 *     after each successful doc compile so the rendered `<Component/>`
 *     picks up updated export bodies via React reference identity.
 *
 * On compile failure we surface a small error card pointing the user to
 * the diff/source toggle so they can edit the JSX by hand.
 */

import { useEffect, useMemo, useState, type ComponentType } from "react";
import type { JsxEditorProps } from "@mdxeditor/editor";
import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, Pencil1Icon } from "@radix-ui/react-icons";
import { compileComponent } from "@workspace/eval";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { rpc } from "@workspace/runtime";
import { mdxComponents } from "@workspace/agentic-chat";
import { nodeToMdxSource } from "./mdastSerialize";

const sandbox = createPanelSandboxConfig(rpc);

// PascalCase component names exported by @workspace/agentic-chat that we
// inject unconditionally into the live-compile wrapper. The set mirrors
// the chat panel's MDX component surface so docs are portable.
const importedNames = Object.keys(mdxComponents as Record<string, unknown>)
  .filter((n) => /^[A-Z]/.test(n));
const importList = importedNames.join(", ");

interface MdastJsxLike {
  type: string;
  name?: string | null;
}

/**
 * Build the wrapper source. `docExportNames` is the list of currently-
 * known doc-level exports; we destructure them from the panel's
 * globalThis stash so references like `<Counter />` resolve. Names
 * collide with built-in imports are filtered out so users can't shadow
 * the agentic-chat surface (e.g. `<Card>`).
 */
function wrapForSandbox(source: string, docExportNames: ReadonlyArray<string>): string {
  const builtinSet = new Set(importedNames);
  const destructured = docExportNames.filter((n) => !builtinSet.has(n) && /^[A-Za-z_$][\w$]*$/.test(n));
  const destructureLine = destructured.length > 0
    ? `const { ${destructured.join(", ")} } = (globalThis.__spectroliteDocExports__ ?? {});`
    : "";
  return `
import * as React from "react";
import { ${importList} } from "@workspace/agentic-chat";

function WikiLink({ target, children }) {
  return (
    <a
      href="#"
      style={{ textDecoration: "underline dotted" }}
      onClick={(e) => { e.preventDefault(); }}
    >
      {children ?? target}
    </a>
  );
}

// useDocState — Spectrolite publishes the hook on globalThis (see
// DocumentEditor) so sandboxed components can persist state into the
// doc's frontmatter without an import the sandbox can't resolve.
const useDocState = (globalThis.__spectroliteUseDocState__) ||
  function useDocStateFallback(_key, initial) {
    return React.useState(initial);
  };

// runtime — the panel's MDX runtime namespace (Eval, useDocState…),
// shared with the whole-doc compile so <runtime.Eval/> works the same
// way in both Edit and (former) Preview surfaces.
const runtime = globalThis.__spectroliteRuntime__ || { useDocState };

// Doc-level exports: destructured by name so a node like <Counter/>
// (where Counter is an export const declared elsewhere in the same
// doc) resolves. Updated by DocumentEditor on every doc-compile.
${destructureLine}

export default function LiveJsx() {
  return (<>
    ${source}
  </>);
}
`;
}

export interface LiveJsxEditorOwnProps {
  /** Frontmatter-declared dependencies, merged into compileComponent imports. */
  dependencies?: Record<string, string>;
  /** Names of doc-level exports currently in scope. */
  docExportNames?: ReadonlyArray<string>;
  /** Bumped by DocumentEditor whenever the doc compile succeeds so we
   *  recompile this node and pick up updated export bodies. */
  docExportsVersion?: number;
}

export function LiveJsxEditor(props: JsxEditorProps & LiveJsxEditorOwnProps) {
  const { mdastNode, descriptor, dependencies, docExportNames, docExportsVersion } = props;
  const tagName = (mdastNode as unknown as MdastJsxLike).name ?? descriptor.name ?? "Fragment";
  const source = useMemo(() => nodeToMdxSource(mdastNode), [mdastNode]);
  const namesKey = useMemo(() => (docExportNames ?? []).join(","), [docExportNames]);
  const wrapped = useMemo(
    () => wrapForSandbox(source, docExportNames ?? []),
    [source, namesKey],
  );
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setComponent(null);
    if (!source.trim()) {
      return () => { cancelled = true; };
    }
    void compileComponent(wrapped, {
      loadImport: sandbox.loadImport,
      sourcePath: `workspace/panels/spectrolite/inline-jsx-${tagName === "*" ? "wild" : tagName}.tsx`,
      imports: dependencies && Object.keys(dependencies).length > 0 ? dependencies : undefined,
    }).then((result) => {
      if (cancelled) return;
      if (result.success && result.Component) {
        setComponent(() => result.Component as ComponentType);
      } else {
        setError(result.error ?? "compile failed");
      }
    });
    return () => { cancelled = true; };
  }, [wrapped, tagName, source, dependencies, docExportsVersion]);

  if (error) {
    return (
      <Card>
        <Flex direction="column" gap="1">
          <Flex align="center" gap="1">
            <ExclamationTriangleIcon color="red" />
            <Text size="1" color="red" weight="medium">&lt;{tagName}&gt;</Text>
            <Text size="1" color="gray">— preview failed</Text>
          </Flex>
          <Code size="1" style={{ whiteSpace: "pre-wrap" }}>{error}</Code>
          <Text size="1" color="gray">
            <Pencil1Icon /> Use the diff/source toggle to edit the JSX by hand.
          </Text>
        </Flex>
      </Card>
    );
  }

  if (!Component) {
    return (
      <Box style={{ opacity: 0.6 }}>
        <Text size="1" color="gray">Rendering &lt;{tagName}&gt;…</Text>
      </Box>
    );
  }

  return (
    <Box
      className="spectrolite-jsx-block"
      style={{
        position: "relative",
        borderRadius: "var(--radius-2)",
      }}
    >
      <Component />
    </Box>
  );
}
