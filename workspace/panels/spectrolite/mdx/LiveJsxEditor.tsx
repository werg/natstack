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
 * The compiled module imports every Radix/component from
 * `@workspace/agentic-chat` so all of the panel's MDX surface is available
 * unconditionally. `WikiLink` is provided as a local shim (clickable
 * navigation is handled by Preview mode, which uses the real WikiLink
 * component with its context).
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

function wrapForSandbox(source: string): string {
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
}

export function LiveJsxEditor(props: JsxEditorProps & LiveJsxEditorOwnProps) {
  const { mdastNode, descriptor, dependencies } = props;
  const tagName = (mdastNode as unknown as MdastJsxLike).name ?? descriptor.name ?? "Fragment";
  const source = useMemo(() => nodeToMdxSource(mdastNode), [mdastNode]);
  const wrapped = useMemo(() => wrapForSandbox(source), [source]);
  const [Component, setComponent] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setComponent(null);
    if (!source.trim()) {
      // Empty serialization — nothing to render. This happens e.g. when
      // MDXEditor first inserts an empty JSX node before the user adds
      // attributes.
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
  }, [wrapped, tagName, source, dependencies]);

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
      style={{
        position: "relative",
        outline: "1px dashed var(--gray-5)",
        outlineOffset: 4,
        borderRadius: "var(--radius-2)",
      }}
    >
      <Component />
    </Box>
  );
}
