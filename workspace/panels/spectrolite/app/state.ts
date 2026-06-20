/**
 * Spectrolite panel state — the single source of truth rendered by the UI.
 *
 * Under the GAD-native co-edit rewrite the editor no longer keeps in-memory
 * disk buffers, a flush pipeline, or git status: each open document owns a
 * `DocController` that commits dirty blocks through the runtime `vcs` and folds
 * remote (scribe) edits in narrowly. The store therefore holds only:
 *   - session / channel / roster,
 *   - the vault selection + the vault-relative path index (from `vcs.listFiles`),
 *   - the active document path + recents,
 *   - transient co-edit surfaces (same-block suggestion cards) and channel UI.
 *
 * Controllers (`session`, `vault`) own the imperative machinery and are the
 * only writers. Components read via `useAppState`.
 */

import type { PubSubClient } from "@workspace/pubsub";
import type { ChatParticipantMetadata } from "@workspace/agentic-core";
import type { AvailableAgent, InstalledAgentRecord } from "../bootstrap";
import type { Collision } from "../coedit/blockReconcile";

export interface RosterAgent {
  handle: string;
  participantId?: string;
  status: "live" | "pending";
}

export interface ChannelMessage {
  id: string;
  senderId: string;
  senderHandle?: string;
  senderName?: string;
  senderType?: string;
  content: string;
  ts: number;
}

/** A live same-block collision surfaced as a SuggestionCard (accept / keep / merge). */
export interface PendingSuggestion {
  /** Stable id so the card can be dismissed/resolved deterministically. */
  id: string;
  /** The vcs path the suggestion applies to (so a doc switch can filter). */
  vcsPath: string;
  collision: Collision;
}

export interface SpectroliteState {
  // ---- session / channel ----
  contextId: string | null;
  channelName: string | null;
  client: PubSubClient<ChatParticipantMetadata> | null;
  installedAgents: InstalledAgentRecord[];
  availableAgents: AvailableAgent[];
  roster: RosterAgent[];
  /** Handles optimistically hidden while a remove call is in flight. */
  removedHandles: ReadonlyArray<string>;

  // ---- vault ----
  /** The vault's workspace-root-relative root, e.g. `projects/default` ("" = tree root). */
  repoRoot: string | null;
  /** Vault-relative `.mdx` paths for the active vault (from `vcs.listFiles`). */
  paths: string[];
  pathsLoading: boolean;
  /** False until the first path scan for the current vault settles. */
  pathsLoaded: boolean;
  /** Vault-relative paths with uncommitted local edits (for the file index dot). */
  dirtyPaths: ReadonlyArray<string>;

  // ---- editor ----
  activePath: string | null;
  recentPaths: string[];
  /** Frontmatter-declared dependencies of the active doc (feeds inline JSX imports). */
  activeDeps: Record<string, string>;

  // ---- co-edit surfaces ----
  /** Live same-block collisions awaiting the user's accept / keep / merge choice. */
  pendingSuggestions: PendingSuggestion[];

  // ---- notices / channel UI ----
  messages: ChannelMessage[];
  /** Bumped to programmatically open the channel dock (e.g. from a toast). */
  dockOpenSignal: number;
}

export function initialState(args: {
  contextId: string | null;
  channelName: string | null;
  repoRoot: string | null;
  openPath: string | null;
  installedAgents: InstalledAgentRecord[];
}): SpectroliteState {
  return {
    contextId: args.contextId,
    channelName: args.channelName,
    client: null,
    installedAgents: args.installedAgents,
    availableAgents: [],
    roster: [],
    removedHandles: [],

    repoRoot: args.repoRoot,
    paths: [],
    pathsLoading: false,
    pathsLoaded: false,
    dirtyPaths: [],

    activePath: args.openPath,
    recentPaths: args.openPath ? [args.openPath] : [],
    activeDeps: {},

    pendingSuggestions: [],

    messages: [],
    dockOpenSignal: 0,
  };
}

/** Roster minus optimistically-removed handles. */
export function visibleRoster(state: SpectroliteState): RosterAgent[] {
  if (state.removedHandles.length === 0) return state.roster;
  return state.roster.filter((agent) => !state.removedHandles.includes(agent.handle));
}
