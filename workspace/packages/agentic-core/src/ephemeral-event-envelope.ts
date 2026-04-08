/**
 * EphemeralEventEnvelope — typed contract for structured ephemeral channel
 * payloads.
 *
 * The pubsub channel-do stores ephemeral messages as
 * `{ id, content: string, contentType?: string }`. We layer a typed
 * convention on top: certain `contentType` values mean "the content is JSON
 * encoding a typed payload". `parseEphemeralEvent` decodes the payload while
 * filtering on contentType.
 *
 * The matching writer is `ChannelClient.sendEphemeralEvent<T>` in
 * `@workspace/agentic-do/src/channel-client.ts`.
 */

export interface EphemeralEventEnvelope<T> {
  contentType: string;
  payload: T;
}

/** A minimal ephemeral message shape — what useChannelEphemeralMessages returns. */
export interface EphemeralMessageLike {
  content: string;
  contentType?: string;
}

/**
 * Decode an ephemeral message into a typed payload, filtering by contentType.
 * Returns null if the contentType doesn't match or if the JSON is malformed.
 */
export function parseEphemeralEvent<T>(
  msg: EphemeralMessageLike,
  expectedContentType: string,
): T | null {
  if (msg.contentType !== expectedContentType) return null;
  try {
    return JSON.parse(msg.content) as T;
  } catch {
    return null;
  }
}
