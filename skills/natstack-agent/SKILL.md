---
name: natstack-agent
description: Operate a NatStack workspace server from the command line with the natstack CLI — durable agent sessions, remote file/git access, arbitrary RPC calls, and sandboxed TypeScript eval with a persistent REPL scope. Use when working against a NatStack server from a terminal or script — reading/editing workspace context files, committing changes, calling workspace services, or running code on live data.
---

# NatStack Agent CLI

The `natstack` CLI gives an agent full programmatic access to a paired
NatStack workspace server. Everything below assumes the CLI is on PATH (in
the repo: `pnpm cli ...`).

## Critical rules

- **Pair once, attach once.** Commands need a device credential
  (`natstack remote pair`) and most need an attached agent session
  (`natstack agent attach`). Sessions are durable server entities; a session
  named `default` is used when `--session NAME` is omitted.
- **Paths are remote.** `fs`/`git`/`eval` operate inside the session's
  *context folder on the server*, not the local filesystem. The context is a
  copy-on-write checkout of the workspace tree (e.g. `panels/notes/...`).
- **JSON is automatic when piped.** Results are human text on a TTY and a
  single JSON document when stdout is piped or `--json` is passed. Errors go
  to stderr (`{"error":..., "exitCode":...}` in JSON mode).
- **Exit codes:** `0` ok · `1` operation/RPC error · `2` usage error ·
  `3` auth/connection (not paired, unreachable) · `4` timeout (eval) ·
  `5` stale session (entity retired, or credential targets another server).
- **Discover, don't guess.** `natstack agent services` lists every callable
  RPC service live; `natstack agent services NAME --json` returns full
  argument schemas. `API.md` is the offline snapshot.

## Quick start

```bash
natstack remote pair "natstack://connect?url=...&code=..."   # once per machine
natstack agent attach                  # create/reuse session "default"
natstack fs ls /                       # list the session context root
natstack agent call workspace.listSkills '[]'
natstack eval run -e 'return await services.meta.listServices()'
natstack agent detach --rm             # retire session + remove its context
```

## Command groups

| Group | Commands | Purpose |
|-------|----------|---------|
| `natstack remote` | `pair`, `status`, `invite`, `logout`, `discover`, `start`, `serve` | Device pairing and credentials |
| `natstack agent` | `attach`, `status`, `detach`, `sessions`, `call`, `services`, `skills`, `logs`, `skill` | Sessions, raw RPC, introspection |
| `natstack fs` | `ls`, `read`, `write`, `rm`, `mv`, `cp`, `mkdir`, `stat`, `grep`, `glob` | Files in the session context |
| `natstack git` | `status`, `diff`, `add`, `commit` | Git on a repo inside the context |
| `natstack eval` | `run`, `repl-reset` | Sandboxed TS/JS against the server |

`--help` works at the group level (`natstack fs --help`) and per command
(`natstack fs write --help`).

There is no dedicated worker command: the workerd service is not
shell-callable, so create workers (and DOs) via RPC —
`natstack agent call runtime.createEntity '[{"kind":"worker","source":"workers/NAME"}]'`
— and retire them with `runtime.retireEntity`. See
[RECIPES.md](RECIPES.md) for a full example.

## Files in this skill

| File | Read when |
|------|-----------|
| [FILES.md](FILES.md) | Doing file or git operations (`fs`/`git` flags, binary handling, repo paths) |
| [EVAL.md](EVAL.md) | Running code with `natstack eval` (bindings, imports, persistent scope) |
| [API.md](API.md) | Looking up which RPC services/methods exist (generated reference) |
| [RECIPES.md](RECIPES.md) | End-to-end workflows (edit+commit, data analysis, debugging units) |
