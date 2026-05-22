/**
 * The `runtime` namespace exposed to MDX content.
 *
 *   - `<runtime.Eval code="…" />` — compile + render arbitrary TSX in the
 *     panel sandbox (with full runtime access via the panel's loadImport).
 *     Frontmatter-declared dependencies are merged in via DepsContext.
 *   - `runtime.useDocState(key, initial)` — same hook as `useDocState`,
 *     reachable from MDX-defined components without an import.
 *
 * Lives in its own module so both the unified editor's per-JSX-node
 * compile (`LiveJsxEditor`) and the whole-doc compile (`docModule`) can
 * share the same `runtime` object identity. That matters for context
 * propagation: DepsContext is used by `<runtime.Eval>` to pick up the
 * doc's frontmatter dependencies, and useDocState relies on the
 * `DocStateContext.Provider` mounted in `DocumentEditor`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { Card, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { compileComponent, type SandboxOptions } from "@workspace/eval";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import { rpc } from "@workspace/runtime";
import { useDocState } from "./docState";

const sandbox = createPanelSandboxConfig(rpc);

/** Frontmatter-declared deps, merged into every `<runtime.Eval>` compile. */
export const DepsContext = createContext<Record<string, string>>({});

interface EvalProps {
  code: string;
  imports?: Record<string, string>;
}

/**
 * Prelude prepended to every Eval block. Exposes Spectrolite hooks
 * without requiring an import the sandbox can't resolve; falls back to
 * vanilla React when the panel isn't around so the same MDX renders in
 * other hosts (e.g. chat panel inline_ui).
 */
const EVAL_PRELUDE = `
import * as __spectrolite_react__ from "react";
const useDocState = (typeof globalThis !== "undefined" && globalThis.__spectroliteUseDocState__) ||
  ((_k, init) => __spectrolite_react__.useState(init));
`;

export function LiveEval({ code, imports }: EvalProps) {
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
    const wrapped = EVAL_PRELUDE + code;
    void compileComponent(wrapped, opts as Parameters<typeof compileComponent>[1]).then((result) => {
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

/** The `runtime` namespace handed to MDX via `useMDXComponents`. */
export const runtimeNamespace = {
  Eval: LiveEval,
  useDocState,
} as Record<string, unknown>;
