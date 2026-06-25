# Files & VCS in a Session Context

All `natstack fs` and `natstack vcs` commands operate inside the **context
folder** of an attached agent session on the server. Pick the session with
`--session NAME` (default `default`); attach it first with
`natstack agent attach [NAME]`. Remote paths are POSIX-style and relative to
the context root (`/` = context root). All commands accept `--json`.

## Sessions

```bash
natstack agent attach [NAME] [--url U --code C]   # create or reuse; --url/--code pair first (errors if already paired)
natstack agent status [NAME]                      # verify the entity is live (exit 5 if stale)
natstack agent sessions                           # list local sessions, live/stale
natstack agent detach [NAME] [--rm]               # retire entity; --rm also deletes the context folder
```

Session records live locally at `~/.config/natstack/agent-sessions/<name>.json`;
the device credential at `~/.config/natstack/cli-credentials.json` (both 0600).

## fs commands

```bash
natstack fs ls [PATH] [-R]                  # list directory; dirs print with trailing "/"; -R recurses
natstack fs read PATH [--out FILE]          # raw bytes to stdout (binary-safe), or save to a local FILE
natstack fs write PATH [CONTENT] [--content TEXT | --from-file F] [--append]
                                            # content from positional, flag, local file, or stdin; creates parents
natstack fs rm PATH [-r]                    # -r for directories
natstack fs mv SRC DEST                     # rename/move
natstack fs cp SRC DEST                     # copy a file
natstack fs mkdir PATH [-p]                 # -p creates parents
natstack fs stat PATH                       # size/mtime/type (JSON)
natstack fs grep PATTERN [PATH] [-i] [--glob G] [-C N] [--max N]
natstack fs glob PATTERN [PATH]             # find files by glob, newest first
```

Notes:

- `fs read` without `--out` writes the file verbatim to stdout (even with
  `--json`), so it is safe for binary files and for piping.
- `fs write` content comes from exactly one of a `CONTENT` positional,
  `--content TEXT`, or `--from-file F` (mutually exclusive; passing more than
  one is a usage error). With none of them, stdin is read when piped; on a
  TTY the command fails with a usage error. `--append` appends instead of
  overwriting.
- `fs grep` human output is classic grep style — `file:NN: match` with
  `file:NN- context` lines and a trailing `(truncated at N matches)` marker.
  `--json` returns `{matches, matchCount, truncated}` with
  `{file, lineNumber, line, before, after}` per match. `-C N` adds context
  lines, `--glob` filters candidate files, `--max` stops after N matches,
  `-i` is case-insensitive. PATTERN is a regular expression.

## vcs: the edit → commit → push loop

VCS is **per-repo**. Every workspace repo — each `section/<name>` under
`packages/ panels/ workers/ extensions/ apps/ about/ skills/ templates/
projects/`, plus the flat `meta` repo — is a first-class versioned unit with its
own log (`vcs:repo:<repoPath>`), its own `main` head, and its own `ctx:*`
context heads. There is no whole-workspace version and no staging area.

Changes flow through **three distinct layers** on your context head:

1. **edit** — `vcs.edit` records tracked **WORKING** changes (also reached via
   `fs write` and the `fs.*` write methods). Always durable with full provenance
   and projected to disk, but it is **not** a commit: no log entry, no head
   advance, **no build**, and edits never appear in `vcs.log`.
2. **commit** — `vcs.commit(message)` folds your uncommitted edits into one
   deliberate, **messaged** snapshot, advancing the repo's context head. The
   `message` is **mandatory**; `exclude` holds paths back. Commits are what
   `vcs.log` shows, and a commit *owns* exactly the edits it sealed
   (`vcs.commitEdits`).
3. **push** — `natstack vcs push --repo <p>` is the **only** way to advance
   `main`. It is **fast-forward-only** and **build-gated** (see below).

Pass a repo with `--repo` (e.g. `--repo panels/notes`, `--repo meta`).

```bash
# edit (via fs, which records a WORKING edit — not yet committed)
natstack fs write panels/notes/src/index.tsx --from-file /tmp/index.tsx

# commit those working edits into a messaged snapshot (RPC — no dedicated command)
natstack agent call vcs.commit '[{"message":"Fix panel registration"}]'

# push the committed snapshot into main — build-gated, fast-forward-only
natstack vcs push --repo panels/notes

natstack vcs status      --repo panels/notes              # this repo's unpushed changes + uncommitted count
natstack vcs diff        --repo panels/notes              # name-status diff of those changes
natstack vcs push-status --repo panels/notes              # how far ahead of main + uncommitted/diverged (pre-push)
natstack vcs log         --repo panels/notes [--limit N]  # this repo's COMMIT history (edits never appear)
natstack vcs fork-repo   panels/chat panels/mychat        # copy a repo to a new path, keeping history
```

`vcs status --repo P --json` returns `{stateHash, dirty, uncommitted, added[],
removed[], changed[], deleted}` for the one repo (a state-diff of its context
head vs its own `main`). `uncommitted` is the count of working edits **not yet
committed** — a push refuses while this is `> 0`. `vcs diff` is the name-status
(`A`/`M`/`D`) view of the same change set.

### vcs.edit / vcs.commit / vcs.discardEdits (RPCs)

The CLI has dedicated commands only for push and the read/status family; the
edit and commit layers are RPCs via `natstack agent call` (and `fs write` is the
ergonomic front-door for `vcs.edit`):

| RPC | shape | what it does |
|-----|-------|--------------|
| `vcs.edit` | `[{"edits":[…],"repoPath":"panels/notes"}]` | Record WORKING edits on your ctx head. No commit, no build, not in `vcs.log`. Returns `{head, stateHash, committed:false, status:"uncommitted", editSeq, changedPaths}`. Rejects a `main` head. |
| `vcs.commit` | `[{"message":"…","repoPaths":?,"exclude":?}]` | Fold uncommitted edits into a messaged snapshot **per repo**. `message` mandatory; omit `repoPaths` to commit every repo your context has edits in; `exclude` leaves listed paths uncommitted (inverse of `git add`). Returns `VcsCommitResult[]` (`{repoPath, head, stateHash, eventId, headHash, editCount, status:"committed"\|"unchanged", changedPaths}`). Rejects `main`. |
| `vcs.discardEdits` | `["panels/notes"]` | Drop a repo's uncommitted edits **and** clear any in-progress merge, restoring the committed head on disk. Returns `{discarded, stateHash}`. |

An edit op is discriminated by `kind` (`replace`/`write`/`create`/`delete`/
`chmod`); `{path, content:"…"}` is accepted shorthand for a write.

### Reconciling divergence: vcs.merge

`push` is **fast-forward-only**. If `main` advanced past your context head's base
since you forked, push returns `status:"diverged"` (it does **not** merge for
you). Reconcile with an explicit `vcs.merge`, then re-push:

| RPC | shape | what it does |
|-----|-------|--------------|
| `vcs.merge` | `["panels/notes"]` | Pull `main` into your ctx head as a **merge commit**. Returns `{status, stateHash, conflicts, mergeable:"clean"\|"conflict", upstreamCommits, conflictPaths?}`. |

- **`mergeable:"clean"`** — no overlapping changes; the merge commits with **no
  file resolution needed**. The ctx head now descends from `main`, so the next
  push fast-forwards.
- **`mergeable:"conflict"`** — overlapping changes; conflict **markers are
  written into your context filesystem** at `conflictPaths`. Resolve them
  (`fs read` → fix → `fs write`, i.e. a `vcs.edit`), then **`vcs.commit`** to
  seal the merge resolution. Then re-push.

`upstreamCommits` lists the `main` commits this reconcile pulled in. The same
divergence fields (`upstreamCommits` + `mergeable` + `conflictPaths`) appear in
the `diverged` push result so you can decide before merging. See
[BUILDING.md](BUILDING.md#divergence-fast-forward-only-push) for the full flow.

### Provenance queries

Every working edit is recorded with full provenance (actor, turn, invocation),
and commits index the edits they own — so you can trace any line:

| RPC | shape | returns |
|-----|-------|---------|
| `vcs.fileHistory` | `["panels/notes","src/index.tsx"]` | Every edit to a path in commit-lineage order (committed first, then the uncommitted working tail) — file history / blame. |
| `vcs.commitEdits` | `["panels/notes",{"eventId":"evt-123"}]` | The edit-ops a commit owns (commit → its edits). |
| `vcs.commitAncestors` | `["panels/notes","evt-123"]` | Walk a commit's ancestry in the event-keyed commit DAG. |
| `vcs.previewBuild` | `[{"repoPaths":["panels/notes"]}]` | On-demand build of your **working** content (committed head + uncommitted edits), scoped — a dev preview that does **not** touch the published baseline. Builds happen authoritatively only at push. |

### Creating a brand-new repo (first push)

A repo is born the first time you push a path that has committed content on your
context head but no `main` yet. There is no "init" command — you write the
files, **commit** them, then push:

```bash
# 1. Create the unit's files under <section>/<name>/ (here a panel).
#    The create-project skill scaffolds these, or write them directly
#    (fs write records WORKING edits — not yet committed):
natstack fs write panels/mynote/index.tsx \
  --content 'export default function MyNote() { return <div>hi</div>; }'
natstack fs write panels/mynote/package.json --content '{
  "name": "@workspace-panels/mynote",
  "natstack": { "title": "My Note" },
  "dependencies": { "@workspace/runtime": "workspace:*", "@workspace/react": "workspace:*" }
}'

# 2. Commit the working edits into the repo's first snapshot.
natstack agent call vcs.commit '[{"message":"Create mynote panel"}]'

# 3. Push to create the repo's main from empty, build-gated.
natstack vcs push --repo panels/mynote
```

The first push builds the new unit and, if green, writes the repo's `main` as
its first commit (`vcs log --repo panels/mynote` then shows that one entry). For
a package it is identical — create `packages/mylib/{package.json,index.ts}`,
`vcs.commit`, then `natstack vcs push --repo packages/mylib`.

> **Phantom-repo error:** a typo'd or empty `--repo` path errors with
> `unknown repo … has no main and no content` — the push found neither an
> existing `main` nor any committed files on your context head to create one
> from. Check the path, that you actually wrote files there, and that you
> committed them (`vcs.commit`) before pushing.

### Forking a repo (`fork-repo`) — keep history

```bash
natstack vcs fork-repo panels/chat panels/mychat   # FROM_REPO  TO_REPO
```

Forks a repo to a new path **preserving its history**: the new repo's log
descends from the source's lineage, so `vcs log --repo panels/mychat` shows the
inherited commits and your edits build on top of that history. The fork is made
build-valid automatically by rewriting the `package.json` `name` leaf to the new
path; **deeper renames are yours** — component/class names, `defineContract`
sources, DO class bindings — fix those (`fs write` → `vcs.commit`), then
`vcs push --repo panels/mychat`. Returns `{ repoPath, head, inherited, stateHash }`
(`inherited` = commits carried over).

Contrast with a from-scratch new project (above): fork when you want to start
from an existing unit's code **and** keep its lineage; create files + first-push
when you want a clean, empty history.

### push — fast-forward-only, build-gated

`vcs push` is the **only** way to advance a repo's `main`. It is
**fast-forward-only** and **build-gated**: it builds your committed candidate,
and if the build (esbuild bundle) or types (tsc) fail, **no head advances** and
you get the errors back.

- Push pushes **committed** content. It **rejects (throws) if you still have
  uncommitted working edits** — `vcs.commit` (or `vcs.discardEdits`) first.
- Repeat `--repo` for an **atomic group push** — every listed repo advances or
  none does (use it when a change spans repos or breaks a dependent).
- Because it is fast-forward-only, push **never merges for you**. If `main`
  moved past your base it returns `status:"diverged"` — run `vcs.merge`, resolve
  if needed, commit, and re-push.
- Exit codes: `0` on `pushed`/`up-to-date`; non-zero on `diverged` (merge and
  re-push) and `build-failed` (fix the diagnostics).
- Human output prints diagnostics grouped by file as
  `file:line:col  severity  [source] message`. `--json` emits the full
  `VcsPushResult`.

`VcsPushResult` is a discriminated union on `status`:

| `status`       | shape                                            | meaning |
|----------------|--------------------------------------------------|---------|
| `pushed`       | `{ repoPaths, reports: RepoBuildReport[] }`       | main advanced for every repo |
| `up-to-date`   | `{ repoPaths, reports }`                          | nothing to push |
| `diverged`     | `{ divergences: VcsRepoDivergence[] }`            | `main` moved past your base; **no head advanced** — `vcs.merge` then re-push |
| `build-failed` | `{ reports: RepoBuildReport[] }`                  | build/type errors; **no head advanced** |

Each `VcsRepoDivergence` is `{ repoPath, base, mainTip, upstreamCommits,
mergeable:"clean"|"conflict", conflictPaths? }` — the same reconcile fields
`vcs.merge` returns, so you know up front whether the merge will be clean or
need resolution.

Each `RepoBuildReport` is `{ repoPath, unitName?, kind, role:"pushed"|"dependent",
required, status:"ok"|"failed"|"skipped", builds: [{ target, diagnostics:
BuildDiagnostic[] }] }`. A `BuildDiagnostic` is `{ source:"esbuild"|"tsc",
severity, file, line, column, message, lineText?, suggestion? }` — structured,
not a blob, so parse it directly.

> **Rule:** a push that returns `build-failed` did **not** advance `main`. Treat
> its diagnostics as your immediate next task — fix the cited `file:line:col`
> and re-push. A `diverged` push likewise advanced nothing — reconcile with
> `vcs.merge`. Never leave a repo red. See [BUILDING.md](BUILDING.md) for how
> the gate decides what to build and what to skip.

### Context isolation, drift, and rebase

Your session **context** is a *pinned snapshot* of the workspace. Reads resolve
against a fixed base captured when the context started — they do **not** drift as
other contexts push and advance `main` under you. Repos you edit live on your own
`ctx:` head (forked lazily on first edit); everything else reads the pinned base.
The on-disk context folder is **sparse** — a repo's files only appear once it's
materialized (on edit, or on demand for a search); `fs.*` handles this for you.

- `vcs.contextStatus()` → per repo `{ forked, ahead, behind }`. `forked` = your
  context has its own head for this repo (it spans the repo, even with no changes);
  `ahead` = that head has changes not yet in `main` (push them); `behind` = `main`
  advanced past your pin.
- `vcs.rebaseContext()` → when repos are `behind`, this 3-way-merges latest `main`
  into each repo you've edited and re-pins your base so unedited repos also jump to
  latest. Conflicts are reported per repo (resolve, then continue).

Typical loop: edit → `vcs.commit(message)` → `vcs push` (graduates your repo to
`main`). If push comes back `diverged`, `vcs.merge` that repo, resolve+commit if
needed, and re-push. `vcs.rebaseContext()` is the bulk catch-up when several
repos are `behind` your pin.

### Bootstrap (automatic — no command)

There is no migration step. Each repo's `vcs:repo:<path>` log is bootstrapped
automatically on server startup: the server scans the on-disk workspace and, for
any repo whose `main` is missing, snapshots that repo's subtree into its log. A
brand-new repo gets its `main` from its first commit + `vcs push` (which creates
it from empty). Nothing to run by hand.

## Escape hatch: raw RPC

Anything not covered by a dedicated command can be called directly:

```bash
natstack agent call SERVICE.METHOD 'ARGS_JSON' [--target ID]
```

`ARGS_JSON` is a JSON **array** of positional arguments. `fs.*` take
the session's contextId as their first argument (get it from
`natstack agent status --json`). The per-repo VCS methods have these exact arg
shapes (mind which are positional vs object):

| RPC call | `ARGS_JSON` |
|----------|-------------|
| `vcs.edit` | `[{"edits":[…],"repoPath":"panels/notes"}]` — record WORKING edits (no commit/build) |
| `vcs.commit` | `[{"message":"…"}]` — fold uncommitted edits into a snapshot (add `"repoPaths"`/`"exclude"` to scope) |
| `vcs.discardEdits` | `["panels/notes"]` — positional `(repoPath, head?)`; drop uncommitted edits + clear merge |
| `vcs.merge` | `["panels/notes"]` — positional `(repoPath, head?)`; pull `main` in (merge commit) |
| `vcs.status` | `["panels/notes", "ctx:<id>"]` — **positional** `(repoPath, head?)`; result includes `uncommitted` |
| `vcs.log` | `["panels/notes", 10]` — positional `(repoPath, limit?, head?)`; commits only |
| `vcs.push` | `[{"repoPaths":["panels/notes"],"sourceHead":"ctx:<id>"}]` |
| `vcs.pushStatus` | `[["panels/notes"]]` — one array arg; each result has `uncommitted` + `diverged` |
| `vcs.previewBuild` | `[{"repoPaths":["panels/notes"]}]` — dev build of working content (no baseline write) |
| `vcs.fileHistory` | `["panels/notes","src/index.tsx"]` — positional `(repoPath, path, head?, limit?)` |
| `vcs.commitEdits` | `["panels/notes",{"eventId":"evt-123"}]` — a commit's edits |
| `vcs.forkRepo` | `["panels/chat","panels/mychat"]` — positional `(fromPath, toPath)` |
| `vcs.contextStatus` | `[]` — per-repo `{repoPath, forked, ahead, behind, deleted}` for your context |
| `vcs.rebaseContext` | `[]` — pull latest `main` into your edits + re-pin your base |

`--target ID` relays the call to a runtime
entity (panel/worker/DO) instead of the server; relayed methods are
entity-defined and may be plain names without a `SERVICE.` prefix (e.g.
`natstack agent call ping --target worker:...`). See
[API.md](API.md) for the service list and
`natstack agent services NAME --json` for full schemas.

## Other agent commands

```bash
natstack agent services [NAME]    # list RPC services, or describe one (full Zod schemas with --json)
natstack agent skills [NAME]      # list workspace skills, or print one SKILL.md
natstack agent logs UNIT [--since MS] [--level L] [--limit N]   # workspace unit logs
natstack agent skill install [--dir DIR] | print   # install this skill (default ./.claude/skills/natstack-agent)
```
