import type { CardManager, CustomMessageHandle } from "@workspace/agentic-do";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { CustomMessageDisplayMode } from "@workspace/agentic-protocol";
import {
  GMAIL_COMPOSE_STATE_SCHEMA,
  GMAIL_COMPOSE_UPDATE_SCHEMA,
  GMAIL_INBOX_STATE_SCHEMA,
  GMAIL_SETUP_STATE_SCHEMA,
  GMAIL_THREAD_STATE_SCHEMA,
  GMAIL_THREAD_UPDATE_SCHEMA,
  type GmailComposeCardState,
  type GmailInboxCardState,
  type GmailSetupState,
  type GmailThreadCardState,
} from "@workspace/gmail/card-types";
import type { GmailThreadUpdate } from "@workspace/gmail/renderers/gmail-thread.reducer";

export interface GmailMessageTypeSpec {
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  path: string;
  stateSchema: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
}

export const GMAIL_MESSAGE_TYPES: GmailMessageTypeSpec[] = [
  {
    typeId: "gmail.setup",
    displayMode: "row",
    path: "skills/gmail/renderers/gmail-setup.tsx",
    stateSchema: GMAIL_SETUP_STATE_SCHEMA,
  },
  {
    typeId: "gmail.inbox",
    displayMode: "row",
    path: "skills/gmail/renderers/gmail-inbox.tsx",
    stateSchema: GMAIL_INBOX_STATE_SCHEMA,
  },
  {
    typeId: "gmail.thread",
    displayMode: "row",
    path: "skills/gmail/renderers/gmail-thread.tsx",
    stateSchema: GMAIL_THREAD_STATE_SCHEMA,
    updateSchema: GMAIL_THREAD_UPDATE_SCHEMA,
  },
  {
    typeId: "gmail.compose",
    displayMode: "row",
    path: "skills/gmail/renderers/gmail-compose.tsx",
    stateSchema: GMAIL_COMPOSE_STATE_SCHEMA,
    updateSchema: GMAIL_COMPOSE_UPDATE_SCHEMA,
  },
];

export const INBOX_CARD_KEY = "gmail:inbox";
export const SETUP_CARD_KEY = "gmail:setup";

export function threadCardKey(threadId: string): string {
  return `gmail:thread:${threadId}`;
}

export function composeCardKey(composeId: string): string {
  return `gmail:compose:${composeId}`;
}

export interface GmailCardsDeps {
  cards: CardManager;
  sql: SqlStorage;
}

/**
 * Gmail card publishing on top of the platform CardManager. Cards are keyed
 * by stable natural keys so restarts and retries reuse the same message.
 */
export class GmailCards {
  constructor(private readonly deps: GmailCardsDeps) {}

  /** Publish (or update) the singleton inbox desk card for a channel. */
  async publishInbox(channelId: string, payload: GmailInboxCardState): Promise<void> {
    const existing = this.deps.cards.find(channelId, INBOX_CARD_KEY);
    if (existing) {
      await existing.update(payload);
      return;
    }
    await this.deps.cards.getOrCreate(channelId, "gmail.inbox", INBOX_CARD_KEY, payload, {
      displayMode: "row",
    });
  }

  hasInboxCard(channelId: string): boolean {
    return this.deps.cards.find(channelId, INBOX_CARD_KEY) !== null;
  }

  /** Publish (or update) the singleton setup/connection card for a channel. */
  async publishSetup(channelId: string, payload: GmailSetupState): Promise<void> {
    const existing = this.deps.cards.find(channelId, SETUP_CARD_KEY);
    if (existing) {
      await existing.update(payload);
      return;
    }
    await this.deps.cards.getOrCreate(channelId, "gmail.setup", SETUP_CARD_KEY, payload, {
      displayMode: "row",
    });
  }

  /** Publish (or focus) a standalone thread card for a Gmail thread. */
  async publishThread(channelId: string, state: GmailThreadCardState): Promise<void> {
    const handle = this.deps.cards.find(channelId, threadCardKey(state.threadId));
    if (handle) {
      await handle.update(state);
      return;
    }
    await this.deps.cards.getOrCreate(channelId, "gmail.thread", threadCardKey(state.threadId), state, {
      displayMode: "row",
    });
  }

  /** Update a thread card if one exists; threads without cards are no-ops. */
  async updateThread(
    channelId: string,
    threadId: string,
    update: GmailThreadUpdate | GmailThreadCardState
  ): Promise<void> {
    const handle = this.deps.cards.find(channelId, threadCardKey(threadId));
    if (handle) await handle.update(update);
  }

  async createCompose(
    channelId: string,
    state: GmailComposeCardState
  ): Promise<CustomMessageHandle> {
    const composeId = crypto.randomUUID();
    return this.deps.cards.getOrCreate(
      channelId,
      "gmail.compose",
      composeCardKey(composeId),
      state,
      { displayMode: "row" }
    );
  }

  composeByMessageId(channelId: string, messageId: string): CustomMessageHandle | null {
    return this.deps.cards.get(channelId, messageId);
  }

  async updateCompose(
    channelId: string,
    messageId: string | undefined,
    patch: Partial<GmailComposeCardState>
  ): Promise<void> {
    if (!messageId) return;
    const handle = this.deps.cards.get(channelId, messageId);
    if (handle) await handle.update(patch);
  }

  /**
   * Adopt a card that was recovered from channel replay (e.g. after a fork)
   * into the CardManager registry so subsequent updates reuse its identity.
   * Reaches into the custom_cards table CardManager owns; the platform has
   * no adoption API yet.
   */
  adoptRecoveredCard(
    channelId: string,
    naturalKey: string,
    typeId: string,
    messageId: string
  ): void {
    this.deps.sql.exec(
      `INSERT OR IGNORE INTO custom_cards (natural_key, channel_id, message_id, type_id, seq, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      `${channelId}:${naturalKey}`,
      channelId,
      messageId,
      typeId,
      Date.now()
    );
  }
}
