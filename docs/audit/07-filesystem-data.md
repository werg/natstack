# Audit 07 — Filesystem, Paths, and Data Layer

This audit was written against the pre-Durable-Object storage architecture.
The database findings for the former host-owned SQL RPC surface are superseded:
that surface was removed, panel tree state moved to `PanelStoreDO`, browser
data moved to `BrowserDataDO`, webhook ingress moved to `WebhookStoreDO`, and
REPL scopes moved to `ScopeStoreDO`.

Current storage architecture is documented in `docs/architecture/storage.md`.
The remaining non-storage filesystem findings from the original report should
be re-audited against the current `fsService`, context-folder, build-store, and
git-service implementations before being used as an active finding list.
