/**
 * Subpath entry for the agentic client connection.
 *
 * Import via: import { connect } from "@natstack/agentic-messaging/client"
 *
 * Provides the connect() function for establishing agentic channel connections.
 * Use this subpath instead of the main barrel to avoid pulling in tool schemas,
 * image utils, and other heavy modules.
 */
export { connect, createToolsForAgentSDK, type AgentSDKToolDefinition } from "./client.js";
