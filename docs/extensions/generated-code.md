# Generated Extension Code Guide

Generated extensions should optimize for boring, explicit module boundaries.
These rules give generated code the best chance of running without manual fixes.

## Checklist

- Export `activate(ctx)` and return plain async functions.
- Use `ctx.storage`, `ctx.fs`, `ctx.git`, `ctx.workspace`, and other context APIs
  instead of assuming direct host access.
- Keep top-level code side-effect-light. Do heavyweight setup inside
  `activate()`.
- Use ESM imports for generated code.
- For external CommonJS dependencies, use a default import and destructure from
  that object.
- Do not use named imports from packages that are CommonJS, native, or WASM
  backed.
- Leave `dependencyMode` unset unless the generated code has a specific reason.
  The default `auto` mode handles the common case.

## Dependency Examples

Minimal extension:

```json
{
  "name": "@workspace-extensions/example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "natstack": {
    "entry": "index.ts",
    "sourcemap": true,
    "extension": {
      "activationEvents": ["*"]
    }
  }
}
```

```ts
export async function activate(ctx) {
  ctx.log.info("example extension activating");
  return {
    async ping(value) {
      return `pong:${value}`;
    }
  };
}
```

Plain JavaScript package:

```json
{
  "natstack": {
    "extension": {
      "activationEvents": ["*"]
    }
  }
}
```

Native or WASM package:

```json
{
  "natstack": {
    "extension": {
      "activationEvents": ["*"],
      "dependencyMode": "auto"
    }
  }
}
```

Force runtime loading:

```json
{
  "natstack": {
    "extension": {
      "activationEvents": ["*"],
      "dependencyMode": "external"
    }
  }
}
```

## Common Failure Shapes

`require is not defined` means some code crossed an ESM/CommonJS boundary
without an explicit `require`. Check the stack first: it may come from
generated extension code, a bundled dependency, or a host/runtime module. For
native or WASM CommonJS packages, use `auto` or `external`.

`Named export ... not found` usually means generated ESM used a named import
from external CommonJS. Use a default import instead.

`Cannot find module` usually means a dependency was externalized but not
installed in the extension runtime dependency cache.
