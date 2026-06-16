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

## Explore and edit a workspace file, then commit

```bash
natstack fs ls /                                        # context root: panels/, workers/, ...
natstack fs grep "registerPanel" panels/notes -C 2
natstack fs read panels/notes/src/index.tsx > /tmp/index.tsx
# ...edit locally...
natstack fs write panels/notes/src/index.tsx --from-file /tmp/index.tsx
natstack vcs status --repo panels/notes
natstack vcs diff   --repo panels/notes
natstack vcs commit --repo panels/notes -m "Fix panel registration"
```

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
natstack vcs status --repo panels/notes | jq '.files[].path'
```

## Call a service the CLI has no command for

```bash
natstack agent services scope --json | jq '.methods | keys'   # check the schema
natstack agent call workspace.listSkills '[]'
natstack agent call vcs.status "[\"ctx:$(natstack agent status --json | jq -r .contextId)\"]"
```

## Create and call a worker

The workerd service is not shell-callable — create workers through
`runtime.createEntity` with `kind: "worker"` (spec:
`{kind, source, ref?, contextId?, key?, stateArgs?, env?}`; returns
`{id, kind, source, contextId, targetId}`):

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
