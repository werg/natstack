/**
 * Execution pause/resume functionality for agents.
 *
 * This module provides a pause method that agents can use to pause execution
 * for user input or clarification.
 */

import { z } from "zod";

/**
 * Factory function to create a pause method definition.
 *
 * The pause method returns successfully and signals execution to halt.
 * The calling code (responder worker) should monitor isPaused() or listen
 * for the pause event to stop processing when this method is called.
 *
 * @param onPause - Callback invoked when pause is triggered (optional)
 * @returns A method definition for pausing execution
 */
export function createPauseMethodDefinition(
  onPause?: () => void | Promise<void>
) {
  return {
    description: `Pause execution to allow user intervention.

Use this when:
- You need user input to proceed
- The task requires human decision-making
- You want to show progress and wait for user response

The conversation will be paused and can be continued when the user sends the next message.`,

    parameters: z.object({
      reason: z.string().describe("Why execution is being paused (shown to user)"),
    }),

    streaming: false,

    execute: async (
      args: { reason: string },
      _ctx: {
        callId: string;
        callerId: string;
        signal: AbortSignal;
        stream: (content: unknown) => Promise<void>;
      }
    ) => {
      // Call the optional pause handler
      await onPause?.();

      // Return success - pause is not an error, it's intentional execution stop
      return {
        content: [
          {
            type: "text" as const,
            text: `Paused: ${args.reason}`,
          },
        ],
      };
    },
  };
}

