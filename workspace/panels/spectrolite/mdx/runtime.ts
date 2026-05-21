/**
 * JsxComponentDescriptors for MDXEditor.
 *
 * For every component the user is allowed to use inline we declare a
 * descriptor; everything else falls through to MDXEditor's GenericJsxEditor
 * (configured in DocumentEditor.tsx) so the user can pop the source open and
 * hand-edit it.
 *
 * The set mirrors `mdxComponents` from `@workspace/agentic-chat` so the chat
 * panel and Spectrolite render MDX consistently.
 *
 * `Editor` is intentionally omitted here; DocumentEditor.tsx fills it with
 * `GenericJsxEditor` so all known components render the same generic editor.
 * We deliberately do NOT build bespoke editors per component — the user
 * wants the "break open and hand-edit" fallback for all of them, and the
 * agent does the heavy editing.
 */

import type { JsxComponentDescriptor } from "@mdxeditor/editor";

export type DescriptorWithoutEditor = Omit<JsxComponentDescriptor, "Editor">;

function flow(name: string, props: string[] = []): DescriptorWithoutEditor {
  return {
    name,
    kind: "flow",
    source: "@workspace/agentic-chat",
    props: props.map((p) => ({ name: p, type: "string" })),
    hasChildren: true,
  };
}

function inline(name: string, props: string[] = []): DescriptorWithoutEditor {
  return {
    name,
    kind: "text",
    source: "@workspace/agentic-chat",
    props: props.map((p) => ({ name: p, type: "string" })),
    hasChildren: true,
  };
}

export function knownJsxDescriptors(): DescriptorWithoutEditor[] {
  return [
    flow("Callout", ["color"]),
    flow("Card"),
    flow("Box"),
    flow("Flex", ["direction", "gap", "align", "justify"]),
    flow("Heading", ["size"]),
    flow("Text", ["size", "color", "weight"]),
    flow("Blockquote"),
    flow("Table"),
    flow("ActionButton", ["message", "variant", "size"]),
    inline("Badge", ["color", "variant"]),
    inline("Code", ["size"]),
    inline("Link", ["href"]),
    inline("Button", ["variant", "size"]),
  ];
}
