/**
 * @natstack/types - Shared type definitions for NatStack.
 *
 * This is the canonical source for all types shared between the app (src/)
 * and workspace packages. Zero runtime dependencies.
 */

// Form schema types
export type {
  PrimitiveFieldValue,
  FieldValue,
  FieldType,
  ConditionOperator,
  FieldCondition,
  FieldOption,
  SliderNotch,
  FieldWarning,
  FieldDefinition,
  FormSchema,
} from "./form-schema.js";

// Agent types
export type {
  MethodAdvertisement,
  RequiredMethodSpec,
  AgentManifest,
  AgentState,
  AgentInstanceInfo,
  JsonValue,
  GlobalAgentSettings,
  AgentSettings,
} from "./agent-types.js";

// IPC protocol types
export type {
  AgentInitConfig,
  HostToAgentMessage,
  AgentToHostMessage,
} from "./ipc-protocol.js";

// Config types
export type { PubSubConfig } from "./config-types.js";

// Database types
export type {
  DbRunResult,
  DatabaseInterface,
  DatabaseOpener,
  RpcCaller,
  DbClient,
} from "./database.js";

// AI types
export type {
  AIModelInfo,
  AIRoleRecord,
  AIToolDefinition,
  MessageRole,
  TextPart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  Message,
  ToolDefinition,
  OnChunkCallback,
  OnFinishCallback,
  OnStepFinishCallback,
  OnErrorCallback,
  StepFinishResult,
  StreamTextFinishResult,
  StreamTextOptions,
  StreamEvent,
  ToolExecutionResult,
  StreamTextResult,
} from "./ai-types.js";

// Runtime types
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpecCommon,
  AppChildSpec,
  BrowserChildSpec,
  ChildSpec,
} from "./runtime-types.js";

// Git types
export type {
  RepoArgSpec,
  NormalizedRepoArg,
} from "./git-types.js";

// PubSub types
export type {
  AgentBuildError,
} from "./pubsub-types.js";
