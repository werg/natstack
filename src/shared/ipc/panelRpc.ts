// Panel-to-Panel RPC Types
// Runtime contracts for communication between parent and child panels

// =============================================================================
// Message Protocol
// =============================================================================

export interface PanelRpcRequest {
  type: "rpc-request";
  id: string;
  method: string;
  args: unknown[];
}

export interface PanelRpcResponse {
  type: "rpc-response";
  id: string;
  result?: unknown;
  error?: string;
}

export interface PanelRpcEvent {
  type: "rpc-event";
  event: string;
  payload: unknown;
}

export type PanelRpcMessage = PanelRpcRequest | PanelRpcResponse | PanelRpcEvent;

// =============================================================================
// Runtime Schema Types (for validation)
// =============================================================================

export type SchemaType = "string" | "number" | "boolean" | "object" | "array" | "any" | "void";

export interface MethodSchema {
  params: SchemaType[];
  returns: SchemaType;
}

export interface PanelRpcSchema {
  methods: Record<string, MethodSchema>;
  events?: string[];
}

// =============================================================================
// IPC Channel Definitions for Panel RPC
// =============================================================================

export interface PanelRpcIpcApi {
  // Expose methods that can be called by parent/children
  "panel-rpc:expose": (panelId: string, schema: PanelRpcSchema) => void;

  // Call a method on another panel (parent or child)
  "panel-rpc:call": (
    fromPanelId: string,
    toPanelId: string,
    method: string,
    args: unknown[]
  ) => unknown;

  // Send an event to another panel
  "panel-rpc:emit": (
    fromPanelId: string,
    toPanelId: string,
    event: string,
    payload: unknown
  ) => void;
}

// =============================================================================
// Helper Types for Panel Code
// =============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFunction = (...args: any[]) => any;

export interface ExposedMethods {
  [methodName: string]: AnyFunction;
}

export interface PanelRpcHandle<T extends ExposedMethods = ExposedMethods> {
  /** The panel ID this handle connects to */
  panelId: string;

  /** Call a method on the remote panel */
  call: {
    [K in keyof T]: T[K] extends AnyFunction
      ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>>
      : never;
  };

  /** Subscribe to events from the remote panel */
  on(event: string, handler: (payload: unknown) => void): () => void;
}

// Generate a schema from method implementations (for runtime use)
export function inferSchema(methods: ExposedMethods): PanelRpcSchema {
  const schema: PanelRpcSchema = { methods: {} };

  for (const [name, fn] of Object.entries(methods)) {
    // We can't truly infer types at runtime, so use 'any' for flexibility
    schema.methods[name] = {
      params: Array(fn.length).fill("any"),
      returns: "any",
    };
  }

  return schema;
}

// Validate a value against a schema type (basic runtime validation)
export function validateType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case "any":
    case "void":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null;
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}
