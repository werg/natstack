/**
 * GAD-native workspace version control client. The RPC methods are derived
 * from the shared `vcsMethods` schema; this module only adds the event helper
 * for head subscriptions.
 */

import { vcsMethods, type VcsHeadAdvance } from "@natstack/shared/serviceSchemas/vcs";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@natstack/shared/typedServiceClient";

export type {
  VcsApplyEditsInput,
  VcsApplyEditsResult,
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
  VcsPublishStatus,
  VcsRecallInput,
  VcsRecallResult,
  VcsResolveHeadResult,
  VcsStatusResult,
  VcsUnitStatus,
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
  };
}
