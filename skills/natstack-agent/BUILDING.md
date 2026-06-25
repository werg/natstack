# Building & the push gate

`natstack vcs push` is the one way to advance a repo's `main`. It is
**fast-forward-only** and **build-gated**: before any head moves, the server
builds your committed candidate and type-checks it. If it doesn't build or
doesn't type-check, **no head advances** and you get structured diagnostics
back. Builds happen authoritatively **only at this push gate** — editing and
committing never build (use `vcs.previewBuild` for a dev preview). This file
explains exactly what the gate builds, what it skips, and how to read what it
returns — so a `build-failed` push is an actionable task, not a mystery.

## The loop

```
edit → vcs.commit(message) → vcs push --repo <p> → read diagnostics → fix file:line:col → re-commit → re-push
```

Push pushes **committed** content. It **rejects if you still have uncommitted
working edits** — `vcs.commit` (or `vcs.discardEdits`) first. A push returns a
`VcsPushResult` (see [FILES.md](FILES.md) for the full shape):

- `pushed` / `up-to-date` — main advanced (or there was nothing to push).
- `diverged` — `main` moved past your base; **no head advanced**. Push is
  fast-forward-only and never merges for you — reconcile with `vcs.merge`
  (resolve + commit if it conflicts), then re-push. See
  [Divergence](#divergence-fast-forward-only-push).
- `build-failed` — the build or types failed; **no head advanced**. Fix the
  cited lines, re-commit, and re-push.

Treat `build-failed` and `diverged` as immediate work. Do not bypass the gate
(there is no "force push") and do not leave a repo red.

## Preview a build before committing

`vcs.previewBuild` builds your **working** content (committed head + uncommitted
edits), scoped to repos or units, **without** advancing any head or touching the
published baseline — a dev preview decoupled from the push gate:

```bash
natstack agent call vcs.previewBuild '[{"repoPaths":["panels/notes"]}]'
```

It returns the same `RepoBuildReport[]` a push does, so you can read diagnostics
mid-edit. The push gate remains the source of truth for "does it build" — don't
use preview as a substitute for pushing.

## What the gate builds (per pushed repo)

The gate maps each pushed repo to a unit in the package graph and decides how to
validate it:

1. **Content-only repos are ungated.** A repo that resolves to no build unit —
   notably `projects/<vault>` (a Spectrolite vault), and the flat `meta` repo —
   is `kind:"content"`, `status:"skipped"`. It pushes without a build. (Editing
   `meta/natstack.yml` advances `vcs:repo:meta` with history but never builds.)

2. **Templates are skipped.** `templates/<name>` is non-buildable content;
   `status:"skipped"`.

3. **Panels / workers / extensions / apps build absolutely.** The pushed unit is
   built (runtime bundle, plus library bundles where relevant). Any error blocks
   the push. This is the "pushed units gate absolutely" rule.

4. **Packages are validated as libraries, not run.** A `packages/<pkg>` repo is
   built as library bundles for the **targets its dependents need** × (the
   package root + each declared export). A package is never eagerly built as an
   app; a compile error in any required library bundle blocks the push. See
   [Reading a package report](#reading-a-package-report-multiple-targets) below.

5. **A malformed build-section unit is a required failure, not a silent skip.**
   If a pushed path under a build section (`packages/ panels/ workers/
   extensions/ apps/ about/`) resolves to no unit — e.g. a missing or invalid
   `package.json` (no `"name"`) — the push fails with a `required` diagnostic at
   `<repoPath>/package.json:1:1` telling you to create/fix the manifest. (Only
   genuine *content* sections — `projects/ skills/ templates/` and `meta` —
   skip; a broken build unit never quietly passes as content.)

## Creating a new repo: the first push

A repo is created by its first commit + push — there is no separate init. Write
the unit's files under `<section>/<name>/` (the create-project skill, `fs write`,
or `vcs.edit`), **`vcs.commit`** them, then push the path; if the build is green,
the repo's `main` is written as its first commit. A typo'd/empty path (or
forgetting to commit) errors with `unknown repo … has no main and no content`.
See [FILES.md → Creating a brand-new repo](FILES.md#creating-a-brand-new-repo-first-push).

A **fork** (`natstack vcs fork-repo FROM TO`) is the other way to get a new
repo — it copies an existing one to a new path **with its history**, rewriting
the `package.json` name leaf so it is build-valid. Make the deeper renames
(components, classes, contract sources), then push the new path. See
[FILES.md → Forking a repo](FILES.md#forking-a-repo-fork-repo--keep-history).

## Dependents gate on *regression* only

Pushing a repo can change a `packages/*` (or shared) API that other units
import. The gate finds the reverse-dependencies whose effective version changed
and re-validates them — but it blocks **only on regression**:

- A dependent that was **green on the base** and goes **red on the candidate**
  blocks the push (`role:"dependent"`, `status:"failed"`).
- A dependent that was **already red** before your push does **not** block it —
  you didn't break it. (It still shows up in the report so you know it's there.)

So the practical consequence: if your change to `packages/ui` breaks
`panels/notes`, the `packages/ui` push fails with `panels/notes` in the report.
Fix both, commit them, and push them **together** as a group:

```bash
natstack agent call vcs.commit '[{"message":"Rename Button prop"}]'   # commits both edited repos
natstack vcs push --repo packages/ui --repo panels/notes
```

A group push is atomic — every repo advances or none does — so a cross-repo API
change lands coherently.

## Divergence (fast-forward-only push)

The push gate only advances `main` by **fast-forward** — your context head must
descend from the current `main`. If `main` advanced past your base since you
forked the repo (another context pushed), the push returns
`status:"diverged"` with a `VcsRepoDivergence` per affected repo and advances
**nothing** — it never force-merges:

```jsonc
{ "status": "diverged",
  "divergences": [
    { "repoPath": "panels/notes", "base": "state:…", "mainTip": "state:…",
      "upstreamCommits": [ … ],            // the main commits you're missing
      "mergeable": "clean",                 // or "conflict"
      "conflictPaths": [ … ] } ] }          // present when mergeable === "conflict"
```

Reconcile with an explicit `vcs.merge` (it pulls `main` into your context head
as a merge commit), then re-push:

```bash
natstack agent call vcs.merge '["panels/notes"]'
# mergeable: "clean"   -> merge already committed; just re-push.
# mergeable: "conflict"-> markers written into the context FS at conflictPaths;
#                          resolve (fs write = vcs.edit), then vcs.commit, then push.
natstack vcs push --repo panels/notes
```

`mergeable` tells you up front whether the reconcile will be clean (a merge
commit, no file resolution) or need you to resolve markers and commit. See
[RECIPES.md → Reconcile a diverged push](RECIPES.md#reconcile-a-diverged-push-vcsmerge)
for the full worked flow.

## Reading diagnostics: esbuild vs tsc

Each `RepoBuildReport.builds[].diagnostics[]` entry has a `source`:

- **`esbuild`** — bundling errors: unresolved imports, syntax errors, missing
  files. esbuild bundles but does **not** type-check, so these are about module
  resolution and parse, e.g. `Could not resolve "./missing"`.
- **`tsc`** — type errors, surfaced because the gate also runs the typecheck
  service over each pushed/affected unit and folds its diagnostics into the same
  list, e.g. `Type 'string' is not assignable to type 'number'.`

Both share one shape — `{ source, severity, file, line, column, message,
lineText?, suggestion? }` — so you parse them uniformly. The CLI prints them
grouped by file:

```
file:line:col  severity  [source] message
    <lineText, when present>
    suggestion: <suggestion, when present>
```

Go straight to `file:line:col`. A `tsc` error usually means a type/contract fix
at that line; an `esbuild` error usually means a bad import path or a missing
file to create.

## Reading a package report (multiple targets)

A pushed **package** validates as several builds at once, so its
`RepoBuildReport.builds[]` has more than one entry. Each entry is one
`(target, exportPath)` combination:

- **`target`** — `library:panel` and/or `library:worker`, chosen from the
  package's dependents' kinds: a `panel`/`about` dependent needs
  `library:panel`; a `worker`/`extension` dependent needs `library:worker`; an
  `app` dependent contributes both. **Fallback: when the package has no known
  dependents, BOTH targets are built** (so a fresh package is fully validated).
- **`exportPath`** — the package root (`"."`) plus every entry in the
  package's `exports`, so a package with `{".":…, "./contract":…}` produces a
  build per export per target.

To find which target failed, correlate by `target` + `exportPath`:

```bash
natstack vcs push --repo packages/ui --json | jq -r '
  .reports[] | select(.repoPath=="packages/ui") | .builds[]
  | "\(.target)\t\(.exportPath // ".")\t\(if (.diagnostics|length)>0 then "FAILED" else "ok" end)"
'
# library:panel    .            ok
# library:panel    ./contract   FAILED
# library:worker   .            ok
# library:worker   ./contract   FAILED
```

That tells you the breakage is in the `./contract` export and reproduces under
the `panel` build — narrow your fix to that entry's diagnostics:

```bash
natstack vcs push --repo packages/ui --json | jq -r '
  .reports[].builds[]
  | select(.exportPath=="./contract")
  | .diagnostics[] | "\(.file):\(.line):\(.column) [\(.source)] \(.message)"
'
```

Two notes on which builds appear in a report:

- A `library:panel` and a `library:worker` build of the same export can fail
  **independently** (e.g. a browser-only import resolves under `panel` but not
  `worker`); fix per target.
- **EV-unchanged dependents are omitted.** The report lists pushed repos and
  only those dependents whose effective version actually changed; a dependent
  whose inputs didn't change is not re-validated and won't appear. Absence from
  the report means "not affected," not "passed silently."

## After a green push

The push report is the **primary** build signal. After a repo is green, use the
diagnostics surfaces only for *runtime* problems on already-running units:

- `natstack agent diag UNIT` — runtime errors/logs + recent build events for a
  running unit.
- `natstack agent logs UNIT [--level error]` — the log tail.
- `build.getBuildReport(unitName, stateHash?)` (RPC) — fetch a build report
  after the fact for a specific state.

For visual/runtime iteration in a panel after a green push, reload it
(`rebuildAndReload`). It rebuilds the panel's current build ref — explicit ref
if pinned, otherwise main — and does not infer `ctx:<contextId>` from the panel
context. Don't use reload-and-poll as a substitute for the push gate. The gate
is the source of truth for "does it build."
