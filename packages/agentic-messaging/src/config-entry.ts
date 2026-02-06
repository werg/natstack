// Agent configuration entry point
// Use: import { CLAUDE_CODE_PARAMETERS, ... } from "@natstack/agentic-messaging/config"

export {
  // Agent parameter definitions
  CLAUDE_CODE_PARAMETERS,
  AI_RESPONDER_PARAMETERS,
  CODEX_PARAMETERS,
  getParameterDefaults,
  // Model fallback lists
  CLAUDE_MODEL_FALLBACKS,
  AI_ROLE_FALLBACKS,
  // Shared UI components
  AUTONOMY_NOTCHES,
  PROJECT_LOCATION_OPTIONS,
  SESSION_PARAMETERS,
  filterPerAgentParameters,
  // Model version utilities
  parseModelVersion,
  compareModelVersions,
  findNewestModel,
  findNewestInFamily,
  getRecommendedDefault,
  type ParsedModelVersion,
} from "./agent-configs.js";
