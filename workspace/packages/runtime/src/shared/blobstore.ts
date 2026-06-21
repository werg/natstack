/**
 * Blobstore client — the portable runtime binding for the per-workspace
 * content-addressable blob store, shared by panel · worker · eval.
 *
 * This is the curated client behind `services.blobstore` / `import { blobstore }
 * from "@workspace/runtime"`. It is a thin typed wrapper over the `blobstore`
 * RPC service (`@natstack/shared/serviceSchemas/blobstore`) — every method
 * forwards to `rpc.call("main", "blobstore.<method>", args)`.
 *
 * Read/write methods (`putText`/`putBase64`/`getText`/`getRange`/`grep`/…) admit
 * `panel`/`worker`/`do` callers (BLOBSTORE_READ_POLICY), so persisting a
 * screenshot or large artifact from agent eval works. Admin methods
 * (`delete`/`list`/`pruneUnreferenced`) are shell/server-only and reject other
 * caller kinds at the service policy gate — same as any other namespaced service
 * method.
 */

import type { RpcCaller } from "@natstack/rpc";
import { createTypedServiceClient, type TypedServiceClient } from "@natstack/shared/typedServiceClient";
import { blobstoreMethods } from "@natstack/shared/serviceSchemas/blobstore";

export type BlobstoreClient = TypedServiceClient<typeof blobstoreMethods>;

/** Ordered method names — single source of truth for the runtime-surface manifest. */
export const BLOBSTORE_MEMBERS = Object.keys(blobstoreMethods);

export function createBlobstoreClient(rpc: RpcCaller): BlobstoreClient {
  return createTypedServiceClient("blobstore", blobstoreMethods, (svc, method, args) =>
    rpc.call("main", `${svc}.${method}`, args)
  );
}
