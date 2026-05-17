# Extension Runtime TODO

- [x] 1. Enforce a Node/ESM-safe extension process boundary.
- [x] 2. Add an end-to-end image-service server smoke test.
- [x] 3. Preserve error causality through RPC, dispatcher, extension host, and logs.
- [x] 4. Store self-describing extension build metadata.
- [x] 5. Support policy-based extension dependency modes.
- [x] 6. Document generated-code patterns for reliable ESM/CommonJS interop.
- [x] 7. Keep extension install/enable/update lifecycle states recoverable.
- [x] 8. Invalidate or repair stale runtime ABI/dependency caches.
- [x] 9. Expose developer diagnostics for extension builds.
- [x] 10. Remove or revise ad-hoc dead-end changes.

## Cleanup Notes

- The proven launcher fix is isolated in commit `68c2459f`.
- The earlier `require is not defined` guidance was revised so it points to the
  stack and module boundary instead of assuming bundled extension code is at
  fault.
- The `photon` loader keeps explicit `createRequire()` loading because
  `@silvia-odwyer/photon-node` is a CommonJS/WASM Node dependency and the
  image-service tests now cover that path.
- `workspace/meta/natstack.yml` is intentionally not part of this cleanup.
