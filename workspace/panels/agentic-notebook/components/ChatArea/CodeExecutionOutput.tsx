import { useState, useEffect, Component, type ReactNode, type ErrorInfo } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";
import type { CodeExecutionData } from "../../types/messages";
import { CodeBlock } from "./CodeBlock";
import { componentRegistry, execute, createBindings } from "../../eval";
import type { ComponentType } from "react";
import { isValidComponent } from "../../utils/componentUtils";
import { CopyButton } from "../shared/CopyButton";

/**
 * Error boundary state for catching render errors in dynamic components.
 */
interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/**
 * Error boundary to catch and display errors from dynamically rendered components.
 */
class ComponentErrorBoundary extends Component<
  { children: ReactNode; fallback?: (error: Error) => ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Component render error:", error, info);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return this.props.fallback?.(this.state.error) ?? (
        <Text color="red" size="1">
          Component crashed: {this.state.error.message}
        </Text>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders a dynamic component from the registry.
 * Handles rehydration if the component is missing but code is provided.
 */
function DynamicComponentRenderer({
  componentId,
  code,
}: {
  componentId: string;
  code?: string;
}) {
  const [Component, setComponent] = useState<ComponentType | undefined>(
    () => componentRegistry.get(componentId)
  );
  const [isRehydrating, setIsRehydrating] = useState(false);
  const [rehydrationError, setRehydrationError] = useState<string | undefined>();

  useEffect(() => {
    const existing = componentRegistry.get(componentId);
    if (existing) {
      setComponent(() => existing);
      return;
    }

    if (!code) {
      return;
    }

    // Attempt rehydration
    const rehydrate = async () => {
      setIsRehydrating(true);
      try {
        const bindings = createBindings();
        const result = await execute(code, { bindings });

        if (result.success) {
          let component: ComponentType | undefined;

          // Check default export
          if (
            result.value &&
            typeof result.value === "object" &&
            "default" in result.value &&
            isValidComponent((result.value as { default: unknown }).default)
          ) {
            component = (result.value as { default: ComponentType }).default;
          }
          // Check return value
          else if (isValidComponent(result.value)) {
            component = result.value as ComponentType;
          }

          if (component) {
            componentRegistry.registerWithId(componentId, component);
            setComponent(() => component);
          } else {
            setRehydrationError("Code re-executed but returned no component");
          }
        } else {
          setRehydrationError(`Rehydration failed: ${result.error?.message}`);
        }
      } catch (err) {
        setRehydrationError(`Rehydration error: ${err}`);
      } finally {
        setIsRehydrating(false);
      }
    };

    rehydrate();
  }, [componentId, code]);

  if (isRehydrating) {
    return <Text size="1" color="gray">Rehydrating component...</Text>;
  }

  if (rehydrationError) {
    return <Text size="1" color="red">{rehydrationError}</Text>;
  }

  if (!Component) {
    return <Text color="red">Component not found (try re-running the cell)</Text>;
  }

  return (
    <ComponentErrorBoundary
      fallback={(error) => (
        <Box p="2" style={{ background: "var(--red-a2)", borderRadius: 4 }}>
          <Text color="red" size="2">Component error: {error.message}</Text>
        </Box>
      )}
    >
      <Component />
    </ComponentErrorBoundary>
  );
}

/**
 * Format console output entries.
 */
function formatConsoleOutput(
  output: CodeExecutionData["consoleOutput"]
): string {
  return output
    .map((entry) => {
      const args = entry.args
        .map((arg: unknown) =>
          typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
        )
        .join(" ");
      return `[${entry.level}] ${args}`;
    })
    .join("\n");
}

interface CodeExecutionOutputProps {
  result: CodeExecutionData;
}

/**
 * CodeExecutionOutput - Renders code execution results.
 *
 * This is an output-only component that displays:
 * - Dynamic component (if componentId is present)
 * - Console output
 * - Return value
 * - Error message
 *
 * The parent ToolResultDisplay handles the chrome (header, input display, etc).
 */
export function CodeExecutionOutput({ result }: CodeExecutionOutputProps) {
  const hasOutput = result.consoleOutput.length > 0;
  const hasResult = result.result !== undefined;
  const hasError = !!result.error;
  const code = result.code;

  return (
    <Box>
      {/* Dynamic Component */}
      {result.componentId && (
        <Box
          mb="2"
          style={{
            background: "var(--gray-1)",
            borderRadius: "var(--radius-2)",
            padding: "12px",
          }}
        >
          <DynamicComponentRenderer componentId={result.componentId} code={code} />
        </Box>
      )}

      {/* Error */}
      {hasError && result.error && (
        <Box
          style={{
            background: "var(--red-a2)",
            borderRadius: "var(--radius-2)",
            padding: "12px",
            marginBottom: "8px",
          }}
        >
          <Flex justify="between" align="center" mb="1">
            <Text size="1" color="red">
              Error:
            </Text>
            <CopyButton text={result.error} />
          </Flex>
          <CodeBlock code={result.error} language="bash" />
        </Box>
      )}

      {/* Console Output */}
      {hasOutput && (
        <Box
          style={{
            background: "var(--gray-a2)",
            borderRadius: "var(--radius-2)",
            padding: "12px",
            marginBottom: hasResult && !hasError && !result.componentId ? "8px" : "0",
          }}
        >
          <Flex justify="between" align="center" mb="1">
            <Text size="1" color="gray">
              Console:
            </Text>
            <CopyButton text={formatConsoleOutput(result.consoleOutput)} />
          </Flex>
          <CodeBlock code={formatConsoleOutput(result.consoleOutput)} language="bash" />
        </Box>
      )}

      {/* Return Value - hide if component is rendered (shows [Function] which is not useful) */}
      {hasResult && !hasError && !result.componentId && (
        <Box
          style={{
            background: "var(--green-a2)",
            borderRadius: "var(--radius-2)",
            padding: "12px",
          }}
        >
          <Flex justify="between" align="center" mb="1">
            <Text size="1" color="gray">
              Result:
            </Text>
            <CopyButton
              text={
                typeof result.result === "object"
                  ? JSON.stringify(result.result, null, 2)
                  : String(result.result)
              }
            />
          </Flex>
          <CodeBlock
            code={
              typeof result.result === "object"
                ? JSON.stringify(result.result, null, 2)
                : String(result.result)
            }
            language="json"
          />
        </Box>
      )}
    </Box>
  );
}
