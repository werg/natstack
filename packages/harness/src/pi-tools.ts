/**
 * Pi Tool Conversion
 *
 * Converts discovered channel participant methods into Pi-compatible custom tool
 * definitions.
 *
 * The adapter injects discovered methods and a `callMethod` function.
 * This module converts them into the shape Pi SDK's `createAgentSession`
 * expects for `customTools`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A method discovered from a channel participant (injected by the server) */
export interface DiscoveredMethod {
  /** Participant ID that provides this method */
  providerId: string;
  /** Display name of the provider */
  providerName: string;
  /** Method name (snake_case, e.g., "file_read") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for parameters */
  parameters?: Record<string, unknown>;
  /** Whether this is menu-only (not an AI tool) */
  menu?: boolean;
}

/**
 * Pi-compatible custom tool definition.
 *
 * Structurally matches `@mariozechner/pi-coding-agent`'s ToolDefinition so
 * it can be passed to `createAgentSession({ customTools })` with a cast.
 */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate:
      | ((partialResult: {
          content: Array<{ type: string; text?: string }>;
          details: unknown;
        }) => void)
      | undefined,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface ConvertToolsOptions {
  /** Prefix for wire names (default: "pubsub") */
  namePrefix?: string;
}

export interface ConvertToolsResult {
  /** Pi-compatible tool definitions */
  customTools: PiToolDefinition[];
  /** Map from wire name to display name (for action tracking) */
  originalToDisplay: Map<string, string>;
}

/**
 * Convert discovered methods to Pi custom tool definitions.
 *
 * Each tool's execute function delegates to `callMethod`, which the server
 * provides. The adapter never touches pubsub or channel protocols directly.
 *
 * @param methods  Discovered methods from channel participants
 * @param callMethod  Function to invoke a method on a participant
 * @param options  Optional configuration
 */
export function convertToPiTools(
  methods: DiscoveredMethod[],
  callMethod: (
    participantId: string,
    method: string,
    args: unknown,
  ) => Promise<unknown>,
  options?: ConvertToolsOptions,
): ConvertToolsResult {
  const prefix = options?.namePrefix ?? "pubsub";
  const customTools: PiToolDefinition[] = [];
  const originalToDisplay = new Map<string, string>();

  for (const method of methods) {
    // Skip menu-only methods (not AI tools)
    if (method.menu) continue;

    const wireName = `${prefix}_${method.providerId}_${method.name}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );

    customTools.push({
      name: wireName,
      label: wireName,
      description: method.description
        ? `[${method.providerName}] ${method.description}`
        : "",
      parameters: method.parameters ?? {},
      execute: async (_toolCallId, params) => {
        const result = await callMethod(
          method.providerId,
          method.name,
          params,
        );
        const text =
          typeof result === "string" ? result : JSON.stringify(result);
        return {
          content: [{ type: "text" as const, text }],
          details: undefined as unknown,
        };
      },
    });

    originalToDisplay.set(wireName, wireName);
  }

  return { customTools, originalToDisplay };
}
