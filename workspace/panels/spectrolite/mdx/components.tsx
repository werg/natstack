/**
 * Spectrolite-specific MDX components on top of `@workspace/agentic-chat`'s
 * `mdxComponents` set.
 *
 * Currently adds:
 *   - `<WikiLink target="Page">label</WikiLink>` — clickable Obsidian-style
 *     internal link. Resolution is done by the parent via a context value
 *     so the component itself stays purely declarative.
 */

import React, { createContext, useContext, type ReactNode } from "react";
import { Link } from "@radix-ui/themes";
import { mdxComponents as chatMdxComponents } from "@workspace/agentic-chat";

export interface WikilinkContextValue {
  /** Resolve a wikilink target (e.g. "My Note") to a workspace-relative path. */
  resolve: (target: string) => string | null;
  /** Open a workspace-relative path in the editor. */
  open: (path: string) => void;
  /** Open the target if it exists, otherwise create a stub MDX file and open it. */
  openOrCreate: (target: string) => void | Promise<void>;
}

export const WikilinkContext = createContext<WikilinkContextValue | null>(null);

export interface WikiLinkProps {
  target: string;
  children?: ReactNode;
}

export function WikiLink({ target, children }: WikiLinkProps) {
  const ctx = useContext(WikilinkContext);
  const resolved = ctx?.resolve(target) ?? null;
  const label = children ?? target;
  if (!resolved) {
    // Unresolved: click creates a stub at the resolved-at-click-time
    // location (which may still differ from `target` if e.g. a sibling
    // wikilink in the doc created a matching path moments earlier).
    return (
      <Link
        href="#"
        onClick={(e) => {
          e.preventDefault();
          void ctx?.openOrCreate(target);
        }}
        style={{ color: "var(--gray-10)", textDecoration: "underline dashed" }}
        title={`Click to create [[${target}]]`}
      >
        {label}
      </Link>
    );
  }
  // Resolved: open the EXACT path we resolved at render time. Don't
  // re-resolve via openOrCreate on click — if the target was renamed or
  // a competing path was added between render and click, openOrCreate
  // could open a different note or create a spurious new one. The user's
  // intent is "the link I just saw."
  return (
    <Link
      href="#"
      onClick={(e) => {
        e.preventDefault();
        ctx?.open(resolved);
      }}
      title={resolved}
    >
      {label}
    </Link>
  );
}

export const spectroliteMdxComponents: Record<string, unknown> = {
  ...(chatMdxComponents as Record<string, unknown>),
  WikiLink,
};
