/**
 * NatStack Ask-User Extension
 *
 * Pi extension that registers an `ask_user` tool. The tool routes to the
 * worker via a closure-bound callback, which forwards the question(s) to the
 * channel as a feedback_form and awaits the user's answer.
 */

import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

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
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ) => Promise<string>;
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

export function createAskUserExtension(deps: AskUserDeps): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
        "Ask the user a question (or several) and wait for their response. Use when you need user input that's not available from tools.",
      parameters: ASK_USER_PARAMETERS as never,
      execute: async (_toolCallId, params, signal) => {
        const answer = await deps.askUser(params as AskUserParams, signal ?? undefined);
        return {
          content: [{ type: "text" as const, text: answer }],
          details: undefined,
        };
      },
    });
  };
}
