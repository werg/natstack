/**
 * @natstack/agent-patterns
 *
 * Shared pattern libraries for agent development. These patterns provide
 * common functionality used across different agent implementations, reducing
 * boilerplate and ensuring consistent behavior.
 *
 * Patterns included:
 * - **queue**: Message queue with backpressure and flow control
 * - **settings**: Settings persistence with 3-way merge
 * - **trackers**: Typing/thinking/action indicator helpers
 * - **context**: Missed context accumulation for reconnect scenarios
 * - **interrupt**: Pause/resume/abort controller for agent operations
 *
 * @example
 * ```typescript
 * import {
 *   createMessageQueue,
 *   createSettingsManager,
 *   createTrackerManager,
 *   createMissedContextManager,
 *   createInterruptController,
 * } from "@natstack/agent-patterns";
 *
 * // Use patterns in your agent
 * class MyAgent extends Agent<MyState> {
 *   private queue = createMessageQueue({
 *     onProcess: (event) => this.processMessage(event),
 *   });
 *
 *   private interrupt = createInterruptController();
 *
 *   async onEvent(event: EventStreamItem) {
 *     this.queue.enqueue(event);
 *   }
 *
 *   async onSleep() {
 *     this.queue.stop();
 *     await this.queue.drain();
 *   }
 * }
 * ```
 */

// Queue pattern - message processing with backpressure
export {
  createMessageQueue,
  type MessageQueueOptions,
  type MessageQueueStats,
  type MessageQueue,
} from "./queue/index.js";

// Settings pattern - settings persistence with 3-way merge
export {
  createSettingsManager,
  type SettingsManagerOptions,
  type SettingsManager,
} from "./settings/index.js";

// Tracker patterns - typing/thinking/action indicators
export {
  createTrackerManager,
  type TrackerManagerOptions,
  type TrackerManager,
} from "./trackers/index.js";

// Context pattern - missed context accumulation
export {
  createMissedContextManager,
  type MissedContextManagerOptions,
  type MissedContextManager,
} from "./context/index.js";

// Interrupt pattern - pause/resume/abort control
export {
  createInterruptController,
  type InterruptController,
} from "./interrupt/index.js";
