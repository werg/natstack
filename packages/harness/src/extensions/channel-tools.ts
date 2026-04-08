/**
 * NatStack Channel Tools Extension
 *
 * Pi extension that exposes channel participant methods as LLM-callable tools.
 * The roster is read lazily on every reconcile (session_start, turn_start) so
 * mid-session changes are picked up between turns.
 *
 * Tool names are bare method names (no participant prefix). Collisions are
 * prevented by participant handle uniqueness enforced at the channel level
 * (see workspace/workers/pubsub-channel/channel-do.ts subscribe method).
 *
 * Pi has no `unregisterTool`, so once a tool is registered for a session it
 * stays registered. Reconcile uses `pi.setActiveTools` to control which tools
 * are visible to the LLM. Built-in tool names are passed in via `deps.builtinToolNames`
 * so the extension can re-include them when computing the active set.
 */

import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

export interface ChannelToolMethod {
  /** Stable, unique participant handle. NOT the random participantId. */
  participantHandle: string;
  /** Bare method name. Must be unique across the channel. */
  name: string;
  /** LLM-facing description. */
  description: string;
  /** JSON Schema describing the parameters object. */
  parameters: unknown;
}

export interface ChannelToolsDeps {
  /** Returns the current channel roster's tool list. Worker keeps this fresh. */
  getRoster: () => ChannelToolMethod[];
  /** Execute a method on a channel participant, resolved by handle. */
  callMethod: (
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
  /** Built-in tool names to keep active alongside roster tools. */
  builtinToolNames: readonly string[];
}

export function createChannelToolsExtension(
  deps: ChannelToolsDeps,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const registered = new Set<string>();

    const validateRoster = (roster: ChannelToolMethod[]): void => {
      const seen = new Map<string, string>(); // name -> handle
      for (const m of roster) {
        const prev = seen.get(m.name);
        if (prev && prev !== m.participantHandle) {
          throw new Error(
            `Tool name collision: "${m.name}" is advertised by both ` +
              `"${prev}" and "${m.participantHandle}". Channel handle uniqueness ` +
              `was supposed to prevent this — investigate channel-do subscribe logic.`,
          );
        }
        seen.set(m.name, m.participantHandle);
      }
    };

    const reconcile = (): void => {
      const roster = deps.getRoster();
      validateRoster(roster);

      // Register any tools we haven't seen yet. Pi's registerTool is a Map.set
      // under the hood, so re-registering with the same name is a no-op-but-overwrite.
      // We track `registered` ourselves to avoid the overwrite cost when nothing
      // changed and to make the contract explicit.
      for (const method of roster) {
        if (registered.has(method.name)) continue;
        const captured = method;
        pi.registerTool({
          name: captured.name,
          label: captured.name,
          description: captured.description,
          // Pi accepts JSON Schema at runtime; the TSchema type annotation is a
          // compile-time hint that erases. Cast through unknown.
          parameters: (captured.parameters ?? { type: "object" }) as never,
          execute: async (_toolCallId, params, signal) => {
            // Lazy lookup so a tool removed from the roster between registration
            // and execution returns a clean error rather than calling a stale handle.
            const current = deps
              .getRoster()
              .find((m) => m.name === captured.name);
            if (!current) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Tool "${captured.name}" is no longer available — the providing participant has left the channel.`,
                  },
                ],
                details: undefined,
                isError: true,
              };
            }
            const result = await deps.callMethod(
              current.participantHandle,
              captured.name,
              params,
              signal ?? undefined,
            );
            const text =
              typeof result === "string" ? result : JSON.stringify(result);
            return {
              content: [{ type: "text" as const, text }],
              details: undefined,
            };
          },
        });
        registered.add(captured.name);
      }

      // Activate built-in tools + currently-rostered tool names. Tools that
      // were registered earlier but are no longer in the roster get hidden
      // from the LLM by being absent from this active set.
      const activeSet = new Set<string>(deps.builtinToolNames);
      for (const m of roster) activeSet.add(m.name);
      pi.setActiveTools([...activeSet]);
    };

    pi.on("session_start", async () => reconcile());
    pi.on("turn_start", async () => reconcile());
  };
}
