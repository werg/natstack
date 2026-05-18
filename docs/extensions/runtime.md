# Extension Runtime Contract

NatStack extensions are workspace packages under `workspace/extensions/` with a
`natstack.extension` manifest block. The build output is an ESM bundle that runs
in a Node child process, not in the browser or a workerd isolate.

## Manifest

```json
{
  "name": "@workspace-extensions/example",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "natstack": {
    "entry": "index.ts",
    "sourcemap": true,
    "extension": {
      "activationEvents": ["*"],
      "dependencyMode": "auto"
    }
  }
}
```

`dependencyMode` is optional. The default is `auto`.

- `auto`: bundle plain JavaScript dependencies, externalize dependencies with
  native bindings or WASM assets.
- `bundle`: bundle npm dependencies when possible. Use this for simple JS-only
  packages.
- `external`: install and load npm dependencies from runtime `node_modules`.
  Use this when a package needs its own files at runtime.

## Entry Shape

An extension can export `activate(ctx)`. It may return an object whose functions
are invokable through `extensions.invoke`.

```ts
export async function activate(ctx) {
  return {
    async ping(value: string) {
      ctx.log.info("ping", { value });
      return `pong:${value}`;
    }
  };
}
```

An extension can also export a default object with `fetch(request, ctx)` for
HTTP-style routing.

## Dependency Rules

Generated extension code should prefer ESM syntax. For external CommonJS
packages, use default imports:

```ts
import photon from "@silvia-odwyer/photon-node";
const { PhotonImage } = photon;
```

Avoid named imports from external CommonJS packages. They are intentionally made
to fail early because support depends on Node's CommonJS export detection and is
not reliable across generated packages.

## Diagnostics

The build metadata records:

- extension runtime ABI
- dependency mode
- externalized runtime dependencies
- per-dependency classification explanations
- child-process smoke-test result

The build service also exposes `doctorExtension(name)` for a structured report.
