/**
 * GAD-native workspace version control client. The RPC methods are derived
 * from the shared `vcsMethods` schema; this module only adds the event helper
 * for head subscriptions.
 */

import {
  vcsMethods,
  type VcsHeadAdvance,
  type VcsWorkingAdvance,
} from "@natstack/shared/serviceSchemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@natstack/shared/typedServiceClient";

export type {
  VcsApplyEditsInput,
  VcsEditResult,
  VcsCommitInput,
  VcsCommitResult,
  VcsEditOpRow,
  VcsCommitAncestor,
  VcsRepoDivergence,
  VcsUpstreamCommit,
  VcsDiffResult,
  VcsEditOp,
  VcsFileContent,
  VcsFileListEntry,
  VcsFileReadContent,
  VcsFileWriteContent,
  VcsHeadAdvance,
  VcsLogEntry,
  VcsMergeResult,
  VcsPendingMerge,
  VcsPushInput,
  VcsPushResult,
  VcsPushStatus,
  VcsRecallInput,
  VcsRecallResult,
  VcsResolveHeadResult,
  VcsStatusResult,
  VcsWorkingAdvance,
} from "@natstack/shared/serviceSchemas/vcs";

/** Minimal event-capable rpc surface (method form -> param bivariance, so the
 * runtime rpc client is assignable). */
export interface VcsEventRpc {
  on(event: string, listener: (ev: { payload: unknown }) => void): () => void;
}

export type VcsRpcClient = TypedServiceClient<typeof vcsMethods>;

export type VcsClient = VcsRpcClient & {
  /**
   * Subscribe to head advances (commits by any actor on `head`). Fires on each
   * advance with the previous/new state, producing event, actor, file-level
   * delta, and authored edit intent when available. Returns an unsubscribe.
   */
  subscribeHead(head: string, onAdvance: (advance: VcsHeadAdvance) => void): () => void;
  /**
   * Subscribe to UNCOMMITTED working-content advances (`vcs.edit`, incl.
   * `vcs.revert`) on `head`. Distinct from {@link subscribeHead}: working edits
   * are not commits (no log entry, no build). Reactive editors consume this to
   * reflect uncommitted edits and to apply a revert (now a working edit) into
   * the view. Returns an unsubscribe.
   */
  subscribeWorking(head: string, onAdvance: (advance: VcsWorkingAdvance) => void): () => void;
};

export function createVcsClient(
  callMain: <T>(method: string, ...args: unknown[]) => Promise<T>,
  events?: VcsEventRpc
): VcsClient {
  const rpcClient = createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    callMain(`vcs.${method}`, ...args)
  ) as VcsRpcClient;
  return {
    ...rpcClient,
    subscribeHead(head, onAdvance) {
      if (!events?.on) throw new Error("vcs.subscribeHead requires an event-capable rpc");
      const topic = `vcs:head:${head}`;
      const off = events.on(`event:${topic}`, (ev) => onAdvance(ev.payload as VcsHeadAdvance));
      void callMain("events.subscribe", topic).catch(() => {});
      // Pair the server-side subscription with an unsubscribe on teardown.
      // A DO push-subscriber persists (no socket to reap it), so an un-torn-down
      // `events.subscribe` would leak and keep the server pushing to a corpse.
      return () => {
        off();
        void callMain("events.unsubscribe", topic).catch(() => {});
      };
    },
    subscribeWorking(head, onAdvance) {
      if (!events?.on) throw new Error("vcs.subscribeWorking requires an event-capable rpc");
      const topic = `vcs:working:${head}`;
      const off = events.on(`event:${topic}`, (ev) => onAdvance(ev.payload as VcsWorkingAdvance));
      void callMain("events.subscribe", topic).catch(() => {});
      return () => {
        off();
        void callMain("events.unsubscribe", topic).catch(() => {});
      };
    },
  };
}
