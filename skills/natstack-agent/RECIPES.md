# Recipes

End-to-end workflows. All examples assume a paired CLI; in this repo prefix
commands with `pnpm cli`.

## First contact with a server

```bash
natstack remote pair "natstack://connect?url=https://host.ts.net&code=ABC123"
natstack remote status                      # verify credential + reachability
natstack agent attach                       # session "default"
natstack agent services | head              # what can I call?
natstack agent skills                       # what does this workspace document?
```

One-shot variant — when no credential is stored yet, attach can pair first
(if already paired this is a usage error; `natstack remote logout` to re-pair):

```bash
natstack agent attach work --url https://host.ts.net --code ABC123
```

## Explore, edit, commit, and push a repo (the build-gated loop)

The loop is **edit → commit → push**:

1. `fs write` (and the `fs.*` write methods) route through **`vcs.edit`** — and
   you can call `vcs.edit` directly. They record tracked **WORKING** changes on
   your context head and project them to disk, but they are **not** a commit (no
   log entry, no build, never in `vcs.log`).
2. **`vcs.commit(message)`** folds those working edits into a deliberate,
   messaged snapshot — this is what `vcs.log` shows.
3. **`natstack vcs push`** advances `main`, **fast-forward-only** and
   **build-gated**. A push that comes back `build-failed` did NOT advance
   `main` — the diagnostics it prints are your next task list.

```bash
natstack fs ls /                                        # context root: panels/, workers/, ...
natstack fs grep "registerPanel" panels/notes -C 2
natstack fs read panels/notes/src/index.tsx > /tmp/index.tsx
# ...edit locally...
natstack fs write panels/notes/src/index.tsx --from-file /tmp/index.tsx   # WORKING edit
natstack vcs status --repo panels/notes                # changed paths + uncommitted count
natstack agent call vcs.commit '[{"message":"Fix panel registration"}]'  # seal the edits
natstack vcs push   --repo panels/notes                # advance main (build-gated)
```

A successful push prints the per-repo report and exits `0`:

```
pushed panels/notes
  ok       pushed    panels/notes
```

A **build-failed** push prints diagnostics grouped by file as
`file:line:col  severity  [source] message` and exits non-zero:

```
build-failed — main did NOT advance. Fix the diagnostics and re-push:

panels/notes/src/index.tsx:42:7  error  [tsc] Type 'string' is not assignable to type 'number'.
    const count: number = label;
panels/notes/src/index.tsx:58:3  error  [esbuild] Could not resolve "./missing"

2 diagnostics across 1 file(s).
```

Work the loop — read the cited lines, fix, commit, re-push — until it returns
`pushed`:

```bash
natstack fs read panels/notes/src/index.tsx | sed -n '40,44p'   # inspect line 42
# ...fix the type at index.tsx:42 and the import at :58 (fs write = vcs.edit)...
natstack agent call vcs.commit '[{"message":"Fix types + import"}]'   # seal the fix
natstack vcs push --repo panels/notes                                # re-push
```

> Want to check a build **before** committing? `vcs.previewBuild` builds your
> working content without touching `main` or the published baseline:
> `natstack agent call vcs.previewBuild '[{"repoPaths":["panels/notes"]}]'`.

Drive the loop from a script with `--json` (the full `VcsPushResult`):

```bash
result=$(natstack vcs push --repo panels/notes --json) || {
  echo "$result" | jq -r '.reports[].builds[].diagnostics[]
    | "\(.file):\(.line):\(.column) \(.severity) \(.message)"'
  exit 1
}
```

## Create a brand-new project (first push)

A repo is born from its first commit + push — there is no init step. Create the
unit's files under `<section>/<name>/`, commit them, then push the path; a green
build writes the repo's `main` as its first commit.

```bash
# A new panel — write its files (or use the create-project skill), commit, push.
natstack fs write panels/mynote/index.tsx \
  --content 'export default function MyNote() { return <div>hi</div>; }'
natstack fs write panels/mynote/package.json --content '{
  "name": "@workspace-panels/mynote",
  "natstack": { "title": "My Note" },
  "dependencies": { "@workspace/runtime": "workspace:*", "@workspace/react": "workspace:*" }
}'
natstack agent call vcs.commit '[{"message":"Create mynote panel"}]'   # seal the new files
natstack vcs push --repo panels/mynote                                 # creates main from empty
natstack vcs log  --repo panels/mynote                                 # one entry: the first commit
```

A new **package** is the same shape:

```bash
natstack fs write packages/mylib/index.ts --content 'export const add = (a:number,b:number)=>a+b;'
natstack fs write packages/mylib/package.json --content '{ "name": "@workspace/mylib", "exports": { ".": "./index.ts" } }'
natstack agent call vcs.commit '[{"message":"Add mylib package"}]'
natstack vcs push --repo packages/mylib
```

> A typo'd or empty path fails with `unknown repo … has no main and no content`
> — the push found no existing `main` and no committed files on your head to
> seed one (did you `vcs.commit`?).

## Fork an existing repo, keeping history

```bash
natstack vcs fork-repo panels/chat panels/mychat   # FROM_REPO TO_REPO; inherits history
natstack vcs log --repo panels/mychat              # shows the inherited commits
# The package.json name leaf is already rewritten. Make the DEEPER renames yourself:
natstack fs grep -i "chat" panels/mychat           # find component/class/contract names to rename
# ...rename them with fs write (= vcs.edit), then commit and push the fork:
natstack agent call vcs.commit '[{"message":"Fork chat → mychat"}]'
natstack vcs push --repo panels/mychat
```

Fork when you want an existing unit's code **and** its lineage; use the
create-a-new-project flow above when you want a clean empty history.

## Atomic group push across repos

When a fix in one repo breaks a dependent (or a refactor spans several repos),
commit each, then push them together. Repeat `--repo` — the push is
**all-or-none**: every repo's `main` advances or none does.

```bash
# Editing a shared package broke a panel that depends on it — commit both, then
# push them atomically:
natstack agent call vcs.commit '[{"message":"Rename Button prop"}]'   # commits all edited repos
natstack vcs push --repo packages/ui --repo panels/notes
```

If any repo in the group fails the build gate (or diverges), no head advances;
the report tells you which repo and which lines. Fix and re-push the group.

## Reconcile a diverged push (vcs.merge)

`push` is **fast-forward-only**: if `main` moved past your context head's base
since you forked, the push refuses with `status:"diverged"` (it never
force-merges). Reconcile with an explicit `vcs.merge`, then re-push:

```bash
natstack vcs push --repo panels/notes --json | jq -r '.status'   # -> "diverged"

# Pull main into your context head as a merge commit. The result tells you
# whether it was clean or needs resolution.
natstack agent call vcs.merge '["panels/notes"]'
# -> { status, mergeable: "clean" | "conflict", upstreamCommits, conflictPaths? }
```

- **`mergeable:"clean"`** — no overlapping changes; the merge already committed.
  Just re-push: `natstack vcs push --repo panels/notes`.
- **`mergeable:"conflict"`** — conflict markers were written into your context
  filesystem at `conflictPaths`. Resolve each, then commit the resolution and
  re-push:

```bash
natstack agent call vcs.merge '["panels/notes"]' | jq -r '.conflictPaths[]'
natstack fs read panels/notes/src/index.tsx        # contains <<<<<<< / ======= / >>>>>>> markers
# ...edit out the markers (fs write = vcs.edit)...
natstack fs write panels/notes/src/index.tsx --from-file /tmp/resolved.tsx
natstack agent call vcs.commit '[{"message":"Merge main into notes"}]'   # seals the resolution
natstack vcs push --repo panels/notes                                    # now fast-forwards
```

To abandon uncommitted edits (and any pending merge) on a repo, drop them:

```bash
natstack agent call vcs.discardEdits '["panels/notes"]'
```

## Trace provenance: history, blame, and a commit's edits

Every working edit is recorded with provenance, and each commit owns the edits
it sealed — so you can trace any line back to its edit and its commit:

```bash
# File history / blame — every edit to a path (committed first, then the
# uncommitted working tail), newest commit lineage first.
natstack agent call vcs.fileHistory '["panels/notes","src/index.tsx"]'

# The exact edit-ops a commit folded in (commit event id from vcs.log).
natstack agent call vcs.commitEdits '["panels/notes",{"eventId":"evt-123"}]'

# Walk a commit's ancestry in the event-keyed commit DAG.
natstack agent call vcs.commitAncestors '["panels/notes","evt-123"]'
```

## Inspect a single repo's history

Every repo (`packages/foo`, `panels/chat`, `projects/vault`, `meta`) has its own
log — `vcs log --repo` shows only that repo's **commits** (working edits never
appear):

```bash
natstack vcs push-status --repo panels/notes    # how far ahead of main am I?
natstack vcs diff        --repo panels/notes     # name-status of unpushed changes
natstack vcs log         --repo panels/notes --limit 10
natstack vcs log         --repo meta             # config history (meta is a content repo)
```

## Check context drift and rebase

Your session context is a **pinned snapshot** — it doesn't drift as other contexts
push. To see what you've touched and whether `main` has moved past your pin, and to
catch up, use the `vcs.contextStatus` / `vcs.rebaseContext` RPCs:

```bash
# Per-repo {forked, ahead, behind} for your context.
natstack agent call vcs.contextStatus '[]'
# If repos show "behind": merge latest main into your edits + re-pin your base.
natstack agent call vcs.rebaseContext '[]'
```

`ahead` = push it; `behind` = rebase to pick up others' pushes (conflicts are
reported per repo). Useful when running **parallel sessions** that edit overlapping
repos.

## Analyze live data with a persistent REPL

```bash
natstack eval run -e '
  scope.entities = await services.runtime.listEntities({});
  return scope.entities.length;
'
# next run reuses scope.entities — no refetch
natstack eval run -e 'return scope.entities.filter(e => e.kind === "panel").map(e => e.id)'
natstack eval repl-reset      # when the cached state goes stale
```

## Pipe JSON through jq

Output is already JSON when piped:

```bash
natstack agent sessions | jq -r '.[].name'
natstack fs grep "TODO" --max 50 | jq '.matchCount'
natstack vcs status --repo panels/notes | jq '{uncommitted, added, changed, removed}'
natstack vcs push --repo panels/notes --json | jq -r '.status'
```

## Call a service the CLI has no command for

```bash
natstack agent services workspace --json | jq '.methods | keys'   # check the schema
natstack agent call workspace.listSkills '[]'
natstack agent call vcs.status "[\"panels/notes\",\"ctx:$(natstack agent status --json | jq -r .contextId)\"]"
```

## Create and call a worker

The workerd service is not shell-callable — create workers through
`runtime.createEntity` with `kind: "worker"` (spec:
`{kind, source, ref?, contextId?, key?, stateArgs?, env?}`; returns
`{id, kind, source, contextId, targetId}`):

Omitting `ref` launches the main build. `contextId` chooses the worker's runtime
state/files; it does not imply `ctx:<contextId>`. For code that exists only on a
context branch, launch with both `contextId` and `ref: "ctx:<contextId>"`.

```bash
natstack agent call runtime.createEntity '[{"kind":"worker","source":"workers/stats","key":"stats-1"}]'
natstack agent call ping --target "worker:workers/stats:stats-1"   # relayed: plain method name
natstack agent call runtime.retireEntity '[{"id":"worker:workers/stats:stats-1"}]'
```

The same works from eval:

```bash
natstack eval run -e '
  const h = await services.runtime.createEntity({ kind: "worker", source: "workers/stats", key: "stats-1" });
  return h.targetId;
'
```

For a context-local worker build in eval:

```bash
natstack eval run -e '
  const h = await services.runtime.createEntity({
    kind: "worker",
    source: "workers/stats",
    key: "stats-ctx",
    contextId: ctx.contextId,
    ref: `ctx:${ctx.contextId}`,
  });
  return h.targetId;
'
```

## Debug a misbehaving worker/unit

```bash
natstack agent call workspace.units.list '[]'
natstack agent logs my-worker --level warn --limit 100
natstack eval run -e 'return await help("workers")'
```

## Run a script file with npm dependencies

```bash
cat > /tmp/report.ts <<'EOF'
import _ from "lodash";
const files = await fs.glob("**/*.md");
return _.countBy(files, f => f.split("/")[0]);
EOF
natstack eval run /tmp/report.ts --imports '{"lodash":"npm:4"}'
```

## Parallel sessions for isolated work

Each session owns an isolated context folder, so two tasks cannot trample
each other:

```bash
natstack agent attach featureA
natstack agent attach bugfixB
natstack fs write notes.md --content "task A" --session featureA
natstack fs ls / --session bugfixB        # does not see featureA's files
natstack agent detach featureA --rm       # clean up: retire + delete context
```

## Invite another device

```bash
natstack remote invite --ttl-ms 600000    # prints a pairing code + natstack:// link
```

## Install this skill into a project

```bash
natstack agent skill install              # -> ./.claude/skills/natstack-agent
natstack agent skill install --dir ~/myproj/.claude/skills/natstack-agent
```
