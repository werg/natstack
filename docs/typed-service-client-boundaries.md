# Typed Service Client Boundaries

Shared service schema tables under `packages/shared/src/serviceSchemas` are the source of truth for main-process RPC contracts. Production host, shell, mobile, shared, and extension-client code should call those services through `createTypedServiceClient` or a domain wrapper built on it.

Allowed generic dispatch boundaries:

- Typed-client adapter lambdas may call `rpc.call("main", `${service}.${method}`, args)` when they are passed directly to `createTypedServiceClient`.
- Transport forwarders such as `ServerClient` may dispatch dynamic service and method names after caller policy checks.
- `extensions.invokeStream` may use `rpc.stream("main", "extensions.invokeStream", ...)` because it returns a live `Response`, not a JSON-compatible service return value.
- `packages/shared/src/userlandServiceRpc.ts` may call `workers.resolveService` as its single typed-host bootstrap hop before dispatching to a dynamically resolved userland Durable Object target.
- Workspace userland packages outside the host/shared migration roots may still contain legacy raw calls until those packages receive typed runtime clients.

The CI guard in `tests/typed-service-client-guard.test.ts` enforces the migrated roots and documents any approved raw literal calls. New raw literal `main` calls in those roots should be replaced with typed clients, not added to the allowlist.
