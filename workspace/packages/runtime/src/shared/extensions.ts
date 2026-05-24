import {
    createExtensionsClient,
    type Disposable,
    type ExtensionName,
    type ExtensionsClient,
    type ExtensionSource,
    type RegistryEntry,
    type WorkspaceExtensions,
} from "@natstack/extension";
export {
    createExtensionsClient,
    type Disposable,
    type ExtensionName,
    type ExtensionsClient,
    type ExtensionSource,
    type RegistryEntry,
    type WorkspaceExtensions,
};

// Pull the generated registry barrel into every program that reaches the
// extensions client (all panels import this via @workspace/runtime). Its
// type-only re-exports activate each extension's `WorkspaceExtensions`
// augmentation, so `extensions.use("...")` type-checks in scoped programs (the
// per-panel typecheck service, Monaco) the same way it does under repo-wide tsc.
export type * from "./extensions-registry.js";
