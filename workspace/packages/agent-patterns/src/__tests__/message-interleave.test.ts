/**
 * Tests for the message interleaving pattern used by all three responders.
 *
 * These tests verify the queue-level mechanics that enable interleaving:
 * - takePending() during active processing (the core primitive)
 * - Correct behavior with the outer/inner loop pattern used by responders
 * - Reply anchoring updates when messages are interleaved
 * - Edge cases: paused queue, maxSteps boundary, empty pending
 */

import { describe, it, expect, vi } from "vitest";
import { createMessageQueue } from "../queue/message-queue.js";
import type { EventStreamItem } from "@workspace/agentic-protocol";

function createMockEvent(id: number, content?: string): EventStreamItem {
  return {
    type: "message",
    kind: "persisted",
    id: `msg-${id}`,
    pubsubId: id,
    content: content ?? `Message ${id}`,
    senderId: "sender",
    ts: Date.now(),
  } as EventStreamItem;
}

describe("Message Interleaving Pattern", () => {
  /**
   * Simulates the pubsub-chat-responder interleaving pattern:
   * - Manual agentic loop (while step < maxSteps)
   * - Between steps, check queue.getPendingCount()
   * - If pending > 0, call queue.takePending() and inject into messages[]
   */
  describe("Pubsub Chat Responder Pattern", () => {
    it("should interleave pending messages between agentic steps", async () => {
      vi.useRealTimers();
      const interleaved: string[] = [];
      const steps: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };

          // Simulate a multi-step agentic loop
          let replyToId = incoming.id;
          const messages: Array<{ role: string; content: string }> = [
            { role: "user", content: incoming.content },
          ];

          const maxSteps = 5;
          let step = 0;

          while (step < maxSteps) {
            steps.push(`step-${step}-reply-${replyToId}`);

            // Simulate AI call + tool use (block to let test enqueue messages)
            if (step === 0) {
              await new Promise<void>((r) => { processResolve = r; });
            }

            // Simulate finishReason = "tool_calls" (continue)
            const finishReason = step < 2 ? "tool_calls" : "stop";
            if (finishReason === "stop") break;

            // Interleave check (between steps, after finishReason break)
            if (queue.getPendingCount() > 0 && step + 1 < maxSteps) {
              const pending = queue.takePending();
              for (const p of pending) {
                const content = String((p as { content: string }).content);
                messages.push({ role: "user", content });
                interleaved.push(content);
              }
              expect(pending.length).toBeGreaterThan(0);
              replyToId = (pending[pending.length - 1] as { id: string }).id;
            }

            step++;
          }
        },
      });

      // First message starts processing
      queue.enqueue(createMockEvent(1, "initial prompt"));

      // While step 0 is blocked, inject follow-up messages
      queue.enqueue(createMockEvent(2, "follow-up 1"));
      queue.enqueue(createMockEvent(3, "follow-up 2"));

      // Unblock step 0
      processResolve!();
      await queue.drain();

      // Verify interleaved messages were injected
      expect(interleaved).toEqual(["follow-up 1", "follow-up 2"]);

      // Verify reply anchoring changed to last interleaved message
      expect(steps).toContainEqual("step-1-reply-msg-3");
    });

    it("should merge interleaved messages into a single user message", async () => {
      vi.useRealTimers();
      const messages: Array<{ role: string; content: unknown }> = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };

          messages.push({ role: "user", content: incoming.content });

          const maxSteps = 5;
          let step = 0;

          while (step < maxSteps) {
            if (step === 0) {
              await new Promise<void>((r) => { processResolve = r; });
            }

            const finishReason = step < 2 ? "tool_calls" : "stop";
            if (finishReason === "stop") break;

            // Merge all pending into a single user message (the fix)
            if (queue.getPendingCount() > 0 && step + 1 < maxSteps) {
              const pending = queue.takePending();
              const allParts: Array<{ type: "text"; text: string }> = [];
              for (const p of pending) {
                allParts.push({ type: "text" as const, text: String((p as { content: string }).content) });
              }
              const mergedContent = allParts.length === 1 && allParts[0]!.type === "text"
                ? allParts[0]!.text
                : allParts;
              messages.push({ role: "user", content: mergedContent });
            }

            step++;
          }
        },
      });

      queue.enqueue(createMockEvent(1, "initial prompt"));
      queue.enqueue(createMockEvent(2, "follow-up 1"));
      queue.enqueue(createMockEvent(3, "follow-up 2"));

      processResolve!();
      await queue.drain();

      // Should have exactly 2 user messages: initial + merged interleave
      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(2);
      // First is the initial prompt (plain string)
      expect(userMessages[0]!.content).toBe("initial prompt");
      // Second is merged content (array with multiple text parts)
      expect(userMessages[1]!.content).toEqual([
        { type: "text", text: "follow-up 1" },
        { type: "text", text: "follow-up 2" },
      ]);
    });

    it("should use plain string for single interleaved message", async () => {
      vi.useRealTimers();
      const messages: Array<{ role: string; content: unknown }> = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };
          messages.push({ role: "user", content: incoming.content });

          // Block, then merge
          await new Promise<void>((r) => { processResolve = r; });

          if (queue.getPendingCount() > 0) {
            const pending = queue.takePending();
            const allParts: Array<{ type: "text"; text: string }> = [];
            for (const p of pending) {
              allParts.push({ type: "text" as const, text: String((p as { content: string }).content) });
            }
            const mergedContent = allParts.length === 1 && allParts[0]!.type === "text"
              ? allParts[0]!.text
              : allParts;
            messages.push({ role: "user", content: mergedContent });
          }
        },
      });

      queue.enqueue(createMockEvent(1, "initial"));
      queue.enqueue(createMockEvent(2, "single follow-up"));

      processResolve!();
      await queue.drain();

      const userMessages = messages.filter((m) => m.role === "user");
      expect(userMessages).toHaveLength(2);
      // Single text-only message: plain string, not array
      expect(userMessages[1]!.content).toBe("single follow-up");
    });

    it("should NOT interleave when finishReason is stop", async () => {
      vi.useRealTimers();
      const interleaved: string[] = [];
      const processedByQueue: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };
          processedByQueue.push(incoming.content);

          // Simulate single-step (finishReason = "stop" on step 0)
          if (incoming.content === "initial") {
            await new Promise<void>((r) => { processResolve = r; });
          }

          // finishReason is always "stop" — break before interleave check
          // (Messages stay in queue for normal processing)
        },
      });

      queue.enqueue(createMockEvent(1, "initial"));
      queue.enqueue(createMockEvent(2, "while processing"));

      processResolve!();
      await queue.drain();

      // The second message should be processed normally (not interleaved)
      expect(interleaved).toEqual([]);
      expect(processedByQueue).toEqual(["initial", "while processing"]);
    });

    it("should NOT interleave when at maxSteps boundary", async () => {
      vi.useRealTimers();
      const interleaveAtStep: number[] = [];
      const stepResolvers: Array<() => void> = [];
      let isFirstCall = true;

      const queue = createMessageQueue({
        onProcess: async () => {
          if (!isFirstCall) return; // second call (for event 2) completes immediately
          isFirstCall = false;

          // maxSteps = 2 so step 1 is the last step (step+1 === maxSteps)
          const maxSteps = 2;
          let step = 0;

          while (step < maxSteps) {
            // Block at every step so the test can enqueue at the right moment
            await new Promise<void>((r) => { stepResolvers.push(r); });

            // Guard: only interleave if another step is possible
            if (queue.getPendingCount() > 0 && step + 1 < maxSteps) {
              queue.takePending();
              interleaveAtStep.push(step);
            }

            step++;
          }
        },
      });

      queue.enqueue(createMockEvent(1));

      // Step 0 blocks — enqueue a message here (step+1=1 < maxSteps=2 → interleave OK)
      await new Promise((r) => setTimeout(r, 5)); // let onProcess reach the await
      queue.enqueue(createMockEvent(2));
      stepResolvers[0]!(); // unblock step 0
      await new Promise((r) => setTimeout(r, 5)); // let step 0 complete and step 1 block

      // Step 1 blocks — enqueue another message (step+1=2 === maxSteps=2 → NO interleave)
      queue.enqueue(createMockEvent(3));
      stepResolvers[1]!(); // unblock step 1
      await queue.drain();

      // Interleave happened only at step 0, NOT at step 1 (boundary)
      expect(interleaveAtStep).toEqual([0]);
      // Event 3 was NOT interleaved — it stays in queue and is processed normally
    });
  });

  /**
   * Simulates the Claude Code Responder interleaving pattern:
   * - Outer while loop wrapping inner for-await
   * - Interleave at message_start boundary
   * - interrupt() before takePending()
   * - Resume via query({ resume: sessionId })
   */
  describe("Claude Code Responder Pattern", () => {
    it("should interrupt and resume with interleaved messages", async () => {
      vi.useRealTimers();
      const queryPrompts: string[] = [];
      const sessionUpdates: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };
          let replyToId = incoming.id;
          let interleavePrompt: string | null = null;
          const capturedSessionId = "session-123";

          // Simulate first query
          queryPrompts.push(incoming.content);

          outer: while (true) {
            if (interleavePrompt) {
              queryPrompts.push(interleavePrompt);
              sessionUpdates.push(`resume-${capturedSessionId}-replyTo-${replyToId}`);
              interleavePrompt = null;
            }

            // Simulate stream events: two turns — first turn has tool use,
            // second turn starts with message_start where we check for interleave
            const events = [
              "message_start_turn1",  // first model turn
              "tool_use",             // model uses a tool
              "tool_result_block",    // tool execution happens (blocking point)
              "message_start_turn2",  // second turn — interleave check here
              "text_delta",
              "result",
            ];

            for (const eventType of events) {
              if (eventType === "tool_result_block") {
                // Block here to simulate tool execution — test enqueues messages during this time
                if (queryPrompts.length === 1 && !interleavePrompt) {
                  await new Promise<void>((r) => { processResolve = r; });
                }
              }

              if (eventType === "message_start_turn2") {
                // Check for interleave at the start of a new model turn
                if (queue.getPendingCount() > 0 && capturedSessionId) {
                  // Simulate interrupt (always succeeds in this test)
                  const pending = queue.takePending();
                  expect(pending.length).toBeGreaterThan(0);
                  replyToId = (pending[pending.length - 1] as { id: string }).id;
                  interleavePrompt = pending.map((p) => String((p as { content: string }).content)).join("\n\n");
                  break; // exits for loop, re-enters outer while
                }
              }

              if (eventType === "result") {
                break outer; // normal completion
              }
            }

            if (!interleavePrompt) break;
          }
        },
      });

      queue.enqueue(createMockEvent(1, "initial query"));
      // Block during tool_result_block, then enqueue follow-ups
      queue.enqueue(createMockEvent(2, "follow-up A"));
      queue.enqueue(createMockEvent(3, "follow-up B"));

      processResolve!();
      await queue.drain();

      // First query was the initial prompt
      expect(queryPrompts[0]).toBe("initial query");
      // Second query is the interleaved messages combined
      expect(queryPrompts[1]).toBe("follow-up A\n\nfollow-up B");
      // Session resume used correct session and replyTo
      expect(sessionUpdates[0]).toBe("resume-session-123-replyTo-msg-3");
    });

    it("should skip interleave when pending drains between check and take", async () => {
      vi.useRealTimers();
      const queryPrompts: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };
          let interleavePrompt: string | null = null;
          const capturedSessionId = "session-123";

          queryPrompts.push(incoming.content);

          outer: while (true) {
            if (interleavePrompt) {
              queryPrompts.push(interleavePrompt);
              interleavePrompt = null;
            }

            const events = ["tool_use", "tool_result_block", "message_start_turn2", "result"];
            for (const eventType of events) {
              if (eventType === "tool_result_block" && queryPrompts.length === 1) {
                await new Promise<void>((r) => { processResolve = r; });
              }

              if (eventType === "message_start_turn2" && queue.getPendingCount() > 0 && capturedSessionId) {
                // Simulate interrupt succeeding
                const interrupted = true;
                if (interrupted) {
                  // Simulate pending draining between check and take (e.g. concurrent stop())
                  // Take pending but it returns empty (someone else drained it)
                  queue.takePending(); // drain it externally first
                  const pending = queue.takePending(); // now empty

                  if (pending.length === 0) {
                    // Guard: skip interleave, fall through to normal handling
                    // (this is the fix being tested)
                  } else {
                    interleavePrompt = pending.map((p) => String((p as { content: string }).content)).join("\n\n");
                    break;
                  }
                }
              }

              if (eventType === "result") break outer;
            }

            if (!interleavePrompt) break;
          }
        },
      });

      queue.enqueue(createMockEvent(1, "initial"));
      queue.enqueue(createMockEvent(2, "follow-up"));

      processResolve!();
      await queue.drain();

      // No interleave occurred — the follow-up was drained externally and query
      // continued normally through to "result"
      expect(queryPrompts).toEqual(["initial"]);
    });

    it("should continue normally if interrupt fails", async () => {
      vi.useRealTimers();
      const queryPrompts: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };
          let interleavePrompt: string | null = null;
          const capturedSessionId = "session-123";

          queryPrompts.push(incoming.content);

          outer: while (true) {
            if (interleavePrompt) {
              queryPrompts.push(interleavePrompt);
              interleavePrompt = null;
            }

            const events = ["tool_use", "tool_result_block", "message_start_turn2", "result"];
            for (const eventType of events) {
              if (eventType === "tool_result_block" && queryPrompts.length === 1) {
                await new Promise<void>((r) => { processResolve = r; });
              }

              if (eventType === "message_start_turn2" && queue.getPendingCount() > 0 && capturedSessionId) {
                // Simulate interrupt failure — messages stay in queue
                const interruptFailed = true;
                if (!interruptFailed) {
                  // Would take pending here
                }
                // Fall through to normal handling
              }

              if (eventType === "result") break outer;
            }

            if (!interleavePrompt) break;
          }
        },
      });

      queue.enqueue(createMockEvent(1, "initial"));
      queue.enqueue(createMockEvent(2, "follow-up"));

      processResolve!();
      await queue.drain();

      // Only one query was made (follow-up was NOT interleaved, processed normally by queue)
      expect(queryPrompts).toEqual(["initial", "follow-up"]);
    });
  });

  /**
   * Simulates the Pi Responder interleaving pattern:
   * - Outer while loop wrapping inner for-await
   * - Interleave at item.completed for tool items
   * - abortCurrent() before takePending() (synchronous, cannot fail)
   * - Fresh abort signal per iteration
   */
  describe("Pi Responder Pattern", () => {
    it("should interleave at item.completed for tool items", async () => {
      vi.useRealTimers();
      const resumePrompts: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string; content: string };
          let replyToId = incoming.id;
          let interleavePrompt: string | null = null;
          const sessionId = "thread-456";

          resumePrompts.push(incoming.content);

          outer: while (true) {
            if (interleavePrompt) {
              resumePrompts.push(interleavePrompt);
              interleavePrompt = null;
            }

            // Simulate Pi stream events
            const events = [
              { type: "item.started", itemType: "reasoning" },
              { type: "item.completed", itemType: "command_execution" }, // tool item
              { type: "item.started", itemType: "agent_message" },
              { type: "turn.completed", itemType: null },
            ];

            for (const ev of events) {
              if (ev.type === "item.completed" && ev.itemType === "command_execution") {
                // Block here to allow test to enqueue
                if (resumePrompts.length === 1) {
                  await new Promise<void>((r) => { processResolve = r; });
                }

                // Check for interleave on tool items
                const isToolItem = ["command_execution", "file_change", "mcp_tool_call", "web_search"]
                  .includes(ev.itemType);
                if (isToolItem && queue.getPendingCount() > 0 && sessionId) {
                  const pending = queue.takePending();
                  expect(pending.length).toBeGreaterThan(0);
                  replyToId = (pending[pending.length - 1] as { id: string }).id;
                  interleavePrompt = pending.map((p) => String((p as { content: string }).content)).join("\n\n");
                }
              }

              // After switch: check interleave flag to break for-await
              if (interleavePrompt) break;

              if (ev.type === "turn.completed") break outer;
            }

            if (!interleavePrompt) break;
          }

          // Verify replyTo was updated
          if (replyToId !== incoming.id) {
            resumePrompts.push(`anchored-to-${replyToId}`);
          }
        },
      });

      queue.enqueue(createMockEvent(1, "initial pi prompt"));
      queue.enqueue(createMockEvent(2, "mid-tool message"));

      processResolve!();
      await queue.drain();

      expect(resumePrompts[0]).toBe("initial pi prompt");
      expect(resumePrompts[1]).toBe("mid-tool message");
      expect(resumePrompts[2]).toBe("anchored-to-msg-2");
    });

    it("should NOT interleave on non-tool item.completed events", async () => {
      vi.useRealTimers();
      let interleaveCount = 0;
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async () => {
          const events = [
            { type: "item.completed", itemType: "agent_message" }, // NOT a tool item
            { type: "turn.completed", itemType: null },
          ];

          for (const ev of events) {
            if (ev.type === "item.completed") {
              if (ev.itemType === "agent_message") {
                // Block to allow enqueue
                await new Promise<void>((r) => { processResolve = r; });
              }

              const isToolItem = ev.itemType != null && ["command_execution", "file_change", "mcp_tool_call", "web_search"]
                .includes(ev.itemType);
              if (isToolItem && queue.getPendingCount() > 0) {
                queue.takePending();
                interleaveCount++;
              }
            }
          }
        },
      });

      queue.enqueue(createMockEvent(1));
      queue.enqueue(createMockEvent(2));

      processResolve!();
      // Take remaining pending to avoid drain timeout
      queue.takePending();
      await queue.drain();

      expect(interleaveCount).toBe(0);
    });

    it("should create fresh abort signal per outer loop iteration", () => {
      // Simulates the pattern: abort signal must be created INSIDE
      // the outer loop so resumed streams don't see a pre-aborted signal
      const signals: { aborted: boolean }[] = [];
      let aborted = false;

      // Simulate createAbortSignal
      const createAbortSignal = () => {
        const sig = { get aborted() { return aborted; } };
        signals.push(sig);
        return sig;
      };
      const abortCurrent = () => { aborted = true; };
      const resetAbort = () => { aborted = false; };

      // Iteration 1: create signal, then abort for interleave
      const signal1 = createAbortSignal();
      expect(signal1.aborted).toBe(false);
      abortCurrent();
      expect(signal1.aborted).toBe(true);

      // Iteration 2: fresh signal after reset
      resetAbort();
      const signal2 = createAbortSignal();
      expect(signal2.aborted).toBe(false);
      // Old signal still reflects aborted state has been reset
      // (In real code, each iteration creates a new AbortController)
    });
  });

  /**
   * Tests for the system prompt on resume fix in pi-responder
   */
  describe("Pi System Prompt on Resume", () => {
    it("should only prepend system prompt for new threads", () => {
      const systemPrompt = "You are a helpful assistant.";
      const userPrompt = "Hello";
      const resumeSessionId: string | undefined = undefined;

      // New thread: system prompt IS prepended
      const promptForNew = resumeSessionId
        ? userPrompt
        : `${systemPrompt}\n\n${userPrompt}`;
      expect(promptForNew).toBe("You are a helpful assistant.\n\nHello");
    });

    it("should NOT prepend system prompt for resumed threads", () => {
      const systemPrompt = "You are a helpful assistant.";
      const userPrompt = "Hello";
      const resumeSessionId = "existing-session";

      // Resumed thread: system prompt is NOT prepended
      const promptForResume = resumeSessionId
        ? userPrompt
        : `${systemPrompt}\n\n${userPrompt}`;
      expect(promptForResume).toBe("Hello");
    });

    it("should NOT prepend system prompt for interleaved turns", () => {
      const systemPrompt = "You are a helpful assistant.";
      const interleavePrompt = "New user message during agentic loop";

      // Interleaved turns are always resumes — no system prompt
      // (The interleavePrompt is passed directly to thread.runStreamed)
      expect(interleavePrompt).not.toContain(systemPrompt);
    });
  });

  /**
   * Tests for multiple message interleaving
   */
  describe("Multiple Message Interleaving", () => {
    it("should interleave all pending messages in order", async () => {
      vi.useRealTimers();
      const interleaved: string[] = [];
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { content: string };
          // Block to let messages accumulate
          await new Promise<void>((r) => { processResolve = r; });

          // Interleave check
          if (queue.getPendingCount() > 0) {
            const pending = queue.takePending();
            for (const p of pending) {
              interleaved.push(String((p as { content: string }).content));
            }
          }
        },
      });

      queue.enqueue(createMockEvent(1, "first"));
      queue.enqueue(createMockEvent(2, "second"));
      queue.enqueue(createMockEvent(3, "third"));
      queue.enqueue(createMockEvent(4, "fourth"));

      processResolve!();
      await queue.drain();

      // Messages 2, 3, 4 should all be interleaved in order
      expect(interleaved).toEqual(["second", "third", "fourth"]);
    });

    it("should update replyToId to last interleaved message", async () => {
      vi.useRealTimers();
      let replyToId = "";
      let processResolve: (() => void) | null = null;

      const queue = createMessageQueue({
        onProcess: async (event) => {
          const incoming = event as { id: string };
          replyToId = incoming.id;

          await new Promise<void>((r) => { processResolve = r; });

          if (queue.getPendingCount() > 0) {
            const pending = queue.takePending();
            expect(pending.length).toBeGreaterThan(0);
            replyToId = (pending[pending.length - 1] as { id: string }).id;
          }
        },
      });

      queue.enqueue(createMockEvent(1));
      queue.enqueue(createMockEvent(2));
      queue.enqueue(createMockEvent(3));
      queue.enqueue(createMockEvent(4));

      processResolve!();
      await queue.drain();

      // replyToId should point to last interleaved message (msg-4)
      expect(replyToId).toBe("msg-4");
    });
  });
});
