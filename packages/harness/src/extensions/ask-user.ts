/**
 * NatStack Ask-User Extension
 *
 * Pi extension that registers an `ask_user` tool. The tool routes to the
 * worker via a closure-bound callback, which forwards the question(s) to the
 * channel as a feedback_form and awaits the user's answer.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { PiExtensionAPI, PiExtensionFactory } from "../pi-extension-api.js";

export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface AskUserParams {
  question?: string;
  questions?: AskUserQuestion[];
}

export interface AskUserDeps {
  /** Sends the question(s) to the channel and awaits the user's answer. */
  askUser: (
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ) => Promise<AgentToolResult<any> | string>;
}

const ASK_USER_PARAMETERS = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description:
        "A single free-text question. Use when you need a one-off answer.",
    },
    questions: {
      type: "array",
      description:
        "Multiple structured questions to present together. Use when you need several answers in one round.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          header: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean" },
        },
        required: ["question"],
      },
    },
  },
};

export function createAskUserExtension(deps: AskUserDeps): PiExtensionFactory {
  return (pi: PiExtensionAPI) => {
    pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
        "Ask the user a question (or several) and wait for their response. Use when you need user input that's not available from tools.",
      parameters: ASK_USER_PARAMETERS as never,
      execute: async (toolCallId, params, signal) => {
        const answer = await deps.askUser(
          toolCallId,
          params as AskUserParams,
          signal ?? undefined,
        );
        if (isAgentToolResult(answer)) return answer;
        return {
          content: [{ type: "text" as const, text: answer }],
          details: undefined,
        };
      },
    });
  };
}

function isAgentToolResult(value: unknown): value is AgentToolResult<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
