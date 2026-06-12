# Files & Git in a Session Context

All `natstack fs` and `natstack git` commands operate inside the **context
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
natstack fs write PATH [CONTENT] [--content TEXT | --from-file F] [--append] [--parents]
                                            # content from positional, flag, local file, or stdin; --parents mkdirs first
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

## git commands

Git operates on a **repo inside the context** — pass its workspace path with
`--repo` (e.g. `--repo panels/notes`). There is no default repo.

```bash
natstack git status --repo panels/notes               # branch, commit, changed files
natstack git diff   --repo panels/notes [--staged]    # raw patch to stdout (string in --json mode)
natstack git add    --repo panels/notes               # stage everything (git add -A)
natstack git commit --repo panels/notes -m "message"  # commit staged changes -> {commitId, summary}
```

`git status --json` returns
`{branch, commit, dirty, files: [{path, status, staged, unstaged}]}`.

## Escape hatch: raw RPC

Anything not covered by a dedicated command can be called directly:

```bash
natstack agent call SERVICE.METHOD 'ARGS_JSON' [--target ID]
```

`ARGS_JSON` is a JSON **array** of positional arguments. `fs.*` and
`git.context*` methods take the session's contextId as their first argument
(get it from `natstack agent status --json`). `--target ID` relays the call to
a runtime entity (panel/worker/DO) instead of the server; relayed methods are
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
