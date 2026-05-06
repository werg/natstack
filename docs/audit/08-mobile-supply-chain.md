# Audit 08 — Mobile App, Deep Links & Supply Chain / Build Integrity

This audit was written before the native SQLite cleanup. Its former native SQL
install-chain finding is superseded: the native SQL dependency, auxiliary
install directory, rebuild scripts, and verification scripts were removed.

Current storage architecture is documented in `docs/architecture/storage.md`.
The remaining mobile, deep-link, release, and dependency findings should be
re-audited against the current dependency tree before this report is treated as
an active finding list.
