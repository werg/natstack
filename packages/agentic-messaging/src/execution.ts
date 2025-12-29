/**
 * Execution pause/resume functionality for agents.
 *
 * This module provides a pause method that agents can use to pause execution
 * for user input or clarification.
 */

/**
 * Factory function to create a pause method definition.
 *
 * The pause method returns successfully and signals execution to halt.
 * The calling code (responder worker) should monitor isPaused() or listen
 * for the pause event to stop processing when this method is called.
 *
 * @param publishPause - Callback to publish pause event to channel with messageId
 * @returns A method definition for pausing execution
 */
export function createPauseMethodDefinition(
  publishPause: (messageId: string, reason: string) => Promise<void>
) {
  return {
    description: `Pause execution to allow user intervention.

Use this when:
- You need user input to proceed
- The task requires human decision-making
- You want to show progress and wait for user response

The conversation will be paused and can be continued when the user sends the next message.`,

    parameters: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why execution is being paused (shown to user)",
        },
      },
      required: ["reason"],
    },

    streaming: false,

    execute: async (
      args: unknown,
      ctx: {
        callId: string;
        callerId: string;
        signal: AbortSignal;
        stream: (content: unknown) => Promise<void>;
      }
    ) => {
      const parsedArgs = args as { reason: string };

      // Return success - pause is not an error, it's intentional execution stop
      // The interrupt handler will publish the pause event with proper messageId
      return {
        content: [
          {
            type: "text" as const,
            text: `Paused: ${parsedArgs.reason}`,
          },
        ],
      };
    },
  };
}

