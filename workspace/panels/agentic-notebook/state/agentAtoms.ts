import { atom } from "jotai";
import type { AgentSession } from "../agent/AgentSession";

/**
 * The current agent session instance.
 */
export const agentAtom = atom<AgentSession | null>(null);

/**
 * Whether the agent is currently streaming a response.
 */
export const isStreamingAtom = atom<boolean>(false);

/**
 * The current model role being used.
 */
export const modelRoleAtom = atom<string>("coding");

/**
 * Available model roles.
 */
export const availableRolesAtom = atom<string[]>([
  "fast",
  "smart",
  "coding",
  "cheap",
]);

