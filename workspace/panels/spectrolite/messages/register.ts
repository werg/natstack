/**
 * Register Spectrolite's custom message types on a connected channel.
 *
 * The TSX source for each type is loaded from this panel's package by path;
 * the channel persists the registration so reload + observer panels all
 * receive the same renderer.
 */

import type { PubSubClient } from "@workspace/pubsub";

export const KB_USER_EDIT_TYPE = "kb.user_edit";
export const KB_COMMIT_TYPE = "kb.commit";

const KB_USER_EDIT_PATH = "panels/spectrolite/messages/kb-user-edit.tsx";
const KB_COMMIT_PATH = "panels/spectrolite/messages/kb-commit.tsx";

export async function registerSpectroliteMessageTypes(client: PubSubClient): Promise<void> {
  const existing = await client.getMessageTypes().catch(() => []);
  const have = new Set(existing.map((d) => d.typeId));

  if (!have.has(KB_USER_EDIT_TYPE)) {
    await client.registerMessageType({
      typeId: KB_USER_EDIT_TYPE,
      displayMode: "row",
      source: { type: "file", path: KB_USER_EDIT_PATH },
    });
  }

  if (!have.has(KB_COMMIT_TYPE)) {
    await client.registerMessageType({
      typeId: KB_COMMIT_TYPE,
      displayMode: "row",
      source: { type: "file", path: KB_COMMIT_PATH },
    });
  }
}
