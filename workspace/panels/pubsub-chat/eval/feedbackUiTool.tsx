import { useCallback, useMemo, useRef } from "react";
import type { ComponentType } from "react";
import { transformCode, executeDefault, validateRequires } from "@natstack/eval";

/**
 * Execute and extract the default export as a React component.
 * This is a thin wrapper around executeDefault with React typing.
 */
function executeComponent(code: string): ComponentType<FeedbackComponentProps> {
  return executeDefault<ComponentType<FeedbackComponentProps>>(code);
}

export interface FeedbackUiToolArgs {
  /** TSX code defining a React component */
  code: string;
}

export interface FeedbackUiToolResult {
  success: boolean;
  /** The compiled React component (if successful) */
  Component?: ComponentType<FeedbackComponentProps>;
  /** Cache key for cleanup (if successful) */
  cacheKey?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Props passed to the feedback component.
 */
export interface FeedbackComponentProps {
  /** Call to resolve the tool with a value */
  resolveTool: (value: unknown) => void;
  /** Call to reject the tool with an error */
  rejectTool: (error: Error) => void;
}

/**
 * Cache for compiled components, keyed by transformed code.
 * This prevents re-compilation on re-renders while ensuring different code produces different components.
 * Cache entries are cleaned up via cleanupFeedbackComponent() after feedback completion.
 */
const componentCache = new Map<string, ComponentType<FeedbackComponentProps>>();

/**
 * Clean up a cached component after the feedback process completes.
 * Call this when the feedback UI is dismissed or resolved.
 */
export function cleanupFeedbackComponent(cacheKey: string): void {
  componentCache.delete(cacheKey);
}

/**
 * Compile a feedback UI component from TSX code.
 */
export function compileFeedbackComponent(args: FeedbackUiToolArgs): FeedbackUiToolResult {
  const { code } = args;

  try {
    const transformed = transformCode(code, { syntax: "tsx" });

    // Validate all required modules are available before execution
    const validation = validateRequires(transformed.requires);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
      };
    }

    // Use transformed code as cache key (unique per distinct code)
    const cacheKey = transformed.code;

    return {
      success: true,
      Component: createComponentFactory(cacheKey),
      cacheKey,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a component factory that injects resolveTool/rejectTool at render time.
 * Uses cacheKey (the transformed code) to look up or store the compiled component.
 */
function createComponentFactory(
  cacheKey: string
): ComponentType<FeedbackComponentProps> {
  return function FeedbackWrapper(props: FeedbackComponentProps) {
    const { resolveTool, rejectTool } = props;
    const resolvedRef = useRef(false);

    // Use useMemo with cacheKey to ensure stable component reference
    const CompiledComponent = useMemo(() => {
      const cached = componentCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const compiled = executeComponent(cacheKey);
      componentCache.set(cacheKey, compiled);
      return compiled;
    }, []);

    const safeResolveTool = useCallback(
      (value: unknown) => {
        if (resolvedRef.current) return;
        resolvedRef.current = true;
        resolveTool(value);
      },
      [resolveTool]
    );

    const safeRejectTool = useCallback(
      (error: Error) => {
        if (resolvedRef.current) return;
        resolvedRef.current = true;
        rejectTool(error);
      },
      [rejectTool]
    );

    return <CompiledComponent resolveTool={safeResolveTool} rejectTool={safeRejectTool} />;
  };
}

/**
 * Tool definition for the feedback_ui tool.
 */
export const feedbackUiToolDefinition = {
  name: "feedback_ui",
  description: `Render an interactive React component to collect user feedback.

## Available Libraries
- **@radix-ui/themes** - Full styled component library (Button, Card, TextField, Dialog, Table, etc.)
- **@radix-ui/react-icons** - 300+ icons
- **All @radix-ui/react-* primitives** - Accordion, Toast, NavigationMenu, Form, etc.
- **@natstack/runtime** - Access to NatStack runtime helpers (e.g. \`buildChildLink\`)

Use standard Radix UI APIs. The component is wrapped in a themed container.

## Links (NatStack)
- Clicking a \`natstack-child:///panels/...\` or \`natstack-child:///workers/...\` link creates a child panel/worker.
- Clicking an \`https://...\` link creates a browser child panel (from app panels).
- Prefer generating child URLs with \`buildChildLink(source, gitRef?)\` when writing code.

## Component Contract
\`\`\`tsx
interface Props {
  resolveTool: (value: unknown) => void;  // Call to complete successfully
  rejectTool: (error: Error) => void;     // Call to report error
}
\`\`\`

## Example
\`\`\`tsx
import { useState } from "react";
import { Button, Card, Flex, Text, TextField } from "@radix-ui/themes";
import { buildChildLink } from "@natstack/runtime";

export default function FeedbackForm({ resolveTool }) {
  const [name, setName] = useState("");
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Text>What's your name?</Text>
        <TextField.Root value={name} onChange={e => setName(e.target.value)} placeholder="Enter name..." />
        <Button onClick={() => resolveTool({ name })}>Submit</Button>
        <a href={buildChildLink("panels/agent-manager")}>Open Agent Manager</a>
      </Flex>
    </Card>
  );
}
\`\`\``,
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "TSX code that defines a React component with export default",
      },
    },
    required: ["code"],
  },
};
