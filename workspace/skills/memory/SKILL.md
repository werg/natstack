---
name: memory
description: Search workspace memory — past conversations, knowledge claims, and committed file content — with provenance, before re-deriving facts.
---

# Workspace Memory

The workspace keeps a searchable memory index over three sources:

| Kind      | What is indexed                                            | When |
| --------- | ---------------------------------------------------------- | ---- |
| `message` | Completed chat/trajectory message text                     | At append time |
| `claim`   | Recorded knowledge claims (subject / predicate / object)   | At append time |
| `file`    | Committed text file content (latest state of each file)    | After each workspace commit |

Every hit carries provenance: the originating event (actor + timestamp) for
messages and claims, the path + content hash for files.

## In-loop tool

Every agent has the `memory_recall` tool available:

```
memory_recall({ query: "retry backoff policy", kinds: ["message", "file"], limit: 10 })
```

Use it before re-deriving facts that may already have been established in an
earlier conversation or written down in the workspace. The recall result is
journaled with the invocation, so replays and audits see exactly what was
recalled and why.

## Eval / panel access

```ts
import { vcs } from "@workspace/runtime";
const { results } = await vcs.recall({ query: "unified log", kinds: ["file"] });
```

## Notes

- The index follows the committed workspace state: uncommitted edits are not
  searchable until committed.
- Queries are term-based (FTS5 where available). Quote nothing; just give
  distinctive terms.
- Index rows are projections (cache): they rebuild from the log and the
  worktree state after any wipe.
