/**
 * Typed service clients for the CLI — thin adapter binding the shared
 * `createTypedServiceClient` (schema-derived call surfaces, see
 * `@natstack/shared/typedServiceClient`) to any transport exposing the CLI's
 * `call("service.method", args)` shape (RpcClient, the eval RunnerRpc, …).
 *
 * The wire format is unchanged: each typed leaf still dispatches
 * `call("<service>.<method>", argsArray)`.
 */

import {
  createTypedServiceClient,
  type ServiceMethodSchemas,
  type TypedServiceClient,
} from "@natstack/shared/typedServiceClient";

/** Anything that can dispatch a raw `"service.method"` RPC with an args array. */
export interface ServiceMethodCaller {
  call(method: string, args: unknown[]): Promise<unknown>;
}

/** Build a typed client for one service over a raw `"service.method"` caller. */
export function typedClient<M extends ServiceMethodSchemas>(
  service: string,
  methods: M,
  rpc: ServiceMethodCaller
): TypedServiceClient<M> {
  return createTypedServiceClient(service, methods, (svc, method, args) =>
    rpc.call(`${svc}.${method}`, args)
  );
}
