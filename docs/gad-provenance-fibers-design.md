# GAD Provenance Fibers — Design Spec

Status: proposal. Pre-release; **no backward compatibility** — schema is reset on
bump (`GadWorkspaceDO.dropPersistenceTables`), so we add/rename freely.

This spec turns GAD's existing ledger kernel into a single, queryable
**provenance graph** that joins the worktree VCS, the agent trajectory, and a
hermeneutic claim model — and feeds the agent a compact, semantically ranked
provenance summary at read time. It is the concrete plan behind the June 2026
GAD review (`docs/gad-system-review-2026-06.md`).

**Already landed** (the cleanup this design assumed): the dead
`gad_file_mutations` / `gad_file_change_hunks` / `gad_file_observations`
projections, `blameGadFileSnippet`, the orphaned `state.file_*` / `memory.*` /
`knowledge.{theory,claim_edge,contradiction}_*` protocol event kinds, and the
`StatePayload` fields that only served those events were removed. So the canonical
`state.*` payload is now exactly `{inputStateHash, outputStateHash,
parentStateHashes?, summary?, metadata?}`, and `gad_worktree_edit_ops` is the
single source of worktree provenance to build blame on.

## 1. Goals

1. **Blame that works in production** — for any file/state, recover which edit
   changed which lines, in which trajectory, by which invocation/turn.
2. **Read-time provenance attachment** — on first read of a file in a session,
   attach a compact, _semantic_ summary (claims first, then sessions/files),
   ranked by relevance to the current session. Deeper exploration is on-demand.
3. **Session-density ranking** — rank attached provenance by the density of
   "relationship fibers" connecting the current session to each candidate, and
   improve that ranking as the session accumulates context.
4. **Self-reinforcing provenance** — the act of querying/including context is
   itself recorded as a fiber, so co-accessed nodes wire together over time.
5. **Hermeneutic memory** — a simple claims-as-nodes + relations model the agent
   uses as working memory, fiber-linked to the trajectories that touch it.
6. **SQL-first** — expose the graph as clean tables/views and prompt the agent
   to chase provenance with its own SQL, judiciously. Do not over-wrap.

## 2. Ground truth this builds on

- The worktree side of blame is already live: every `vcs.applyEdits` writes
  `gad_worktree_edit_ops` rows with `path`, `old_content_hash`,
  `new_content_hash`, `hunks_json` (exact line ranges for `replace`),
  `output_state_hash`, and the producing `event_id`
  (`workspace/workers/gad-store/index.ts`; `src/server/gadVcs/workspaceVcs.ts`).
- The worktree state graph lives on a dedicated log (`VCS_LOG_ID`) with per-context
  heads (`ctx:{id}`, `main`) — _separate_ from the agent trajectory log. The link
  is `contextId`.
- `applyEdits` does **not** thread the editing invocation/turn into the state
  event, so `gad_state_transitions.invocation_id` is null on the live path. This
  is the keystone gap (§4).
- `knowledge.claim_recorded/updated/retracted` events and `projectKnowledge`
  exist but have **no producer**. We add producers (§8).
- File reads are **not recorded** anywhere today. We add `observed` fibers (§3).

## 3. The fiber abstraction

A **fiber** is a typed, directed, weighted edge in one provenance graph. Nodes
are anchors, reusing the existing `anchor_kind`/`anchor_id` convention:

| anchor_kind  | anchor_id                                                      |
| ------------ | -------------------------------------------------------------- |
| `file`       | normalized path                                                |
| `state`      | worktree state hash                                            |
| `invocation` | invocation id                                                  |
| `turn`       | turn id                                                        |
| `session`    | trajectory branch head id (a _hint_, not authority — see §6.4) |
| `claim`      | claim id                                                       |

Fiber kinds and their **base weights** (flat per kind — never scaled by edit
magnitude; see §6.2):

| kind                                                    | src → dst                             | base weight | written by                                          |
| ------------------------------------------------------- | ------------------------------------- | ----------- | --------------------------------------------------- |
| `edited`                                                | invocation → file                     | 1.0         | edit-op ingestion (keystone wire)                   |
| `asserted`                                              | invocation → claim                    | 1.0         | `record_claim` / `revise_claim`                     |
| `cited`                                                 | invocation → claim                    | 1.0         | claim referenced during a turn                      |
| `supports`/`contradicts`/`about`/`refines`/`depends_on` | claim → claim                         | 0.8         | `relate_claims`                                     |
| `observed`                                              | invocation → file                     | 0.5         | read tool                                           |
| `probed`                                                | invocation → file                     | 0.3         | read tool — agent-requested provenance depth (§7.1) |
| `included`                                              | invocation → claim \| file \| session | **0.3**     | read-time attachment + `provenance()`               |

`included` is the self-reinforcing fiber: emitting a provenance attachment writes
`included` fibers from the current invocation to whatever was shown, so showing a
node strengthens its future density. Its weight is deliberately the lowest in the
ladder so the Hebbian loop _cannot_ outrun organic signal — "we showed it"
must always count for less than "the agent edited/asserted it" (echo-chamber
guard; the exact ratio is a tuning knob, §12). `probed` (the depth the agent
_requested_ for a file, §7.1) is treated identically — a soft revealed-preference
signal at the same low weight, so "the agent thought this file worth a deep look"
nudges density without dominating it.

### Schema

```sql
CREATE TABLE gad_fibers (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,          -- canonical: the log event that asserted the fiber
  kind TEXT NOT NULL,
  src_kind TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  session_id TEXT,                 -- denormalized hint: branch head at creation (not authority)
  invocation_id TEXT,
  turn_seq INTEGER,                -- creating turn's ordinal in its branch (for turn-decay)
  weight REAL NOT NULL DEFAULT 1,  -- defaulted from kind; a `weight` hook for future hand-boosts
  created_at TEXT NOT NULL
);
CREATE INDEX idx_fibers_src ON gad_fibers(src_kind, src_id);
CREATE INDEX idx_fibers_dst ON gad_fibers(dst_kind, dst_id, id);
CREATE INDEX idx_fibers_kind ON gad_fibers(kind);
CREATE INDEX idx_fibers_session ON gad_fibers(session_id);

-- Incrementally maintained on every fiber insert; powers the IDF/specificity
-- and normalization terms (§6.2) without a read-time COUNT.
CREATE TABLE gad_node_degree (
  node_kind TEXT NOT NULL,
  node_id TEXT NOT NULL,
  degree INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_kind, node_id)
);
```

Fibers are a projection of fiber-events on the existing log kernel (append a log
event, project a `gad_fibers` row, bump `gad_node_degree`). They are replayable
like every other projection — **not** separate authority from the log.

## 4. Keystone: persist the edit → trajectory causal edge

The single highest-leverage change. Thread causality from the agent tool down to
the state event:

1. `vcs.applyEdits` accepts a `causality: { trajectoryId, invocationId, turnId }`
   (the edit/write tools already run inside an invocation; pass it through —
   `harness/src/tools/edit.ts`, `write.ts`, `tool-vcs.ts`).
2. `WorkspaceVcs.applyEdits` → `ingestWorktreeState` stamps the state event's
   `causality_json` with that invocation/turn.
3. `projectStateTransition` already reads `envelope.causality.invocationId`, so
   `gad_state_transitions.invocation_id` becomes populated.
4. Edit-op ingestion additionally emits one `edited` fiber per changed path —
   `invocation:{id} --edited--> file:{path}`, **flat weight 1.0** (not scaled by
   hunk size), carrying `session_id`/`turn_seq`/`output_state_hash` for joins.

After this, "which conversation/turn/invocation produced this hunk" is a direct
join, and blame is real.

## 5. Blame, rebuilt over edit_ops

`gad_file_mutations` / `gad_file_change_hunks` / `blameGadFileSnippet` are already
deleted. Blame is a view/query over `gad_worktree_edit_ops` joined to the log and
fibers. Sketch — "who last changed these lines of this file at this state":

```sql
SELECT eo.path, eo.hunks_json, eo.old_content_hash, eo.new_content_hash,
       eo.output_state_hash, le.event_id, le.causality_json, st.invocation_id
FROM gad_worktree_edit_ops eo
JOIN log_events le ON le.envelope_id = eo.event_id
LEFT JOIN gad_state_transitions st ON st.event_id = eo.event_id
WHERE eo.path = ?
ORDER BY le.seq DESC;
```

Line-level blame walks `hunks_json` ranges to find the newest op overlapping the
requested lines; whole-file `write` ops (no hunks) fall back to old/new content
hash diff on demand. A query concern, not stored state.

## 6. Session-density ranking

**Density** = personalized spreading activation seeded from the current session's
**touch-set**, over a _bounded_ 2-hop neighborhood, ranked so that connections
which are **specific, recent, and accumulated** float to the top.

`touch(S)` = the anchors the current session has touched (files edited/read,
claims asserted/cited/included, invocations) — accumulated **in memory by the
agent loop** as the turn proceeds (the loop created those fibers, so it needs no
query). It grows during the session, which is why ranking sharpens over a turn.

For a read of file `F`, candidates are claims/sessions/files reachable from `F`'s
editing sessions: editing sessions of `F` (`… --edited--> file:F`), the claims
those sessions `asserted`/`cited`, and the files they co-`edited`.

### 6.1 Score

```
score(C) = idf(C) · Σ_{ paths p : touch(S) ⇝ C, len(p) ≤ 2 }
                       Π_{ edge e ∈ p }  w_kind(e) · decay(e) · norm(src(e))
```

- `w_kind(e)` — the flat per-kind base weight from §3.
- `idf(C) = 1 / log(2 + degree(C))` — **specificity**. A claim/file connected to
  _everything_ is background hum; one connected to exactly the sessions that
  touched `F` is signal. Read straight from `gad_node_degree`.
- `norm(X) = 1 / sqrt(outDegree_kind(X))` — **degree normalization**. Stops a
  50-file refactor (or a promiscuous bridge node) from flooding the touch-set;
  the cosine-style analogue of "don't let big diffs win."
- `decay(e)` — **logical, never the wall clock** (§6.3).

This subsumes the old "direct included boost": a prior `included` fiber from
`touch(S)` to `C` is just a length-1 path carrying `included`'s low weight, so
reinforcement is real but bounded.

### 6.2 Weighting: flat per kind, discriminate by degree

Edit _magnitude_ (lines/hunks) is **not** a weight input — it is a poor proxy for
significance and structurally biases toward generated/vendored/bulk files.
Relationship depth instead emerges from **accumulation** (repeated edits compound
as more fibers) and **kind** (`edited` > `observed` > `included`). The only
multiplicative modulation is the pair `idf`/`norm` above, which rewards
_discriminating_ connections rather than voluminous ones.

### 6.3 Decay basis: logical, two clocks

Wall-clock decay would only be nondeterministic if read _at query time_; the real
reasons to avoid it are (a) never read the clock during ranking, and (b)
activity-distance is a better staleness proxy than the calendar in bursty agentic
work. So:

- **Session-recency leg** (`touch(S) → X`): decay in **turns ago** within the
  current branch chain (`turn_seq` delta). Turns are the natural agent unit and
  back the "N turns ago" label.
- **Historical leg** (`X ~ C`): decay in **per-anchor ordinality** — e.g. how
  many _later_ edits to that file have occurred since the fiber, counted on the
  `idx_fibers_dst` order. **Not** global `log_events.seq`: that single counter is
  shared by every trajectory and channel envelope, so global-seq distance is
  polluted by unrelated activity. Wall-clock `created_at` is kept for display
  only.

### 6.4 Session identity: a position in the trajectory DAG, not a stored id

Do not mint an authoritative `session_id` (or a coarser "conversation id") — it
goes stale and ambiguous exactly at forks. A fiber belongs to its **`event_id`**,
which lives on the immutable trajectory DAG; "the current session" is
**branch-chain reachability from the current head**, the same recursive
parent-chain scoping GAD already uses for `materializePiMessages` and
branch-scoped tool calls. This makes mid-session forks correct for free: a child
branch inherits the parent's pre-fork touch-set and diverges after. The
`gad_fibers.session_id` column is a denormalized _hint_ (branch head at creation)
for cheap filtering; canonical scoping is event/branch-chain. The live session's
touch-set is held in memory, so the common path needs no CTE at all.

### 6.5 Cost: bounded inline, with an offline escape hatch

The query must be **O(neighborhood), independent of total log size** — two
indexed join passes, not `RECURSIVE`:

- **Caps** (which also improve quality): seed = last `K` touches of the session;
  per-node fan-out = top-`M` neighbors by recency (high-degree nodes are
  low-signal per §6.2, so capping is free); candidates = top-`N` shown.
- **Maintained incrementally:** `gad_node_degree` (for `idf`/`norm`) and the live
  touch-set (in memory). No read-time `COUNT`.
- **Escape hatch for richer-than-2-hop ranking on large logs:** materialize a
  `gad_fiber_affinity` table from a _periodic server-driven pass_ — the same
  shape as the existing GC (`runGadGcMark/Sweep`) and memory-FTS reindex passes
  — and have the read look it up in O(1). (Note: the old `gad_index_jobs` queue
  is not in the live schema; this leans on the GC-style periodic-pass pattern, or
  a small job lane, not an existing one.) V1 does not need it; it is the named
  scaling lever, not a launch dependency.

## 7. Read-time attachment: agent-budgeted, parallel, best-effort, warmed

### 7.1 Mandatory budgets on every read

`read` takes two **mandatory** arguments so the agent triages context cost per
file — spending depth where it expects important ramifications and saving it
elsewhere:

- `provenanceDepth: "none" | "blame" | "context" | "trace"` — how far to chase the
  fiber graph for _this_ file.
- `resultBudget: <tokens>` — a ceiling on the **whole** tool result (file content
  - provenance block).

Making them mandatory forces a one-token semantic judgement on every read instead
of a system default the agent never examines — that triage _is_ the value. They
are _requests within system bounds_, not authority: the runtime still enforces
hard ceilings on depth, budget, and wall-clock (`PROV_BUDGET_MS`, §7.3), so "always
ask for max" cannot blow up compute or context.

Depth tiers map straight onto the §6 graph scope and caps:

| depth     | hops | expands                                                                       | when                                         |
| --------- | ---- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| `none`    | 0    | file content only                                                             | you know this file cold; a glance; a re-read |
| `blame`   | 1    | `edited` fibers → who/when last changed these lines, last session(s)          | cheap, line-level "who touched this"         |
| `context` | 2    | full density block — claims, co-edited files, cross-session (§6)              | a file you're about to change                |
| `trace`   | 2+   | follows claim relations (`supports`/`contradicts`/`refines`) + contradictions | the hermeneutic walk; rare, expensive        |

This **subsumes the old first-touch policy**: depth is explicit per call, so there
is no implicit first-touch magic — the agent asks `none` on re-reads/glances and
`context`/`trace` where ramifications matter. `provenance(path | query)` stays for
deepening _without_ re-reading.

**Budget allocation.** Content is primary (it honors the existing range args);
provenance is the adjustable tail. Fill content, then render provenance
densest-first into whatever budget remains, truncating the low-density tail; if
content exhausts the budget, provenance degrades to a one-line `provenance("path")`
hint. The two knobs compose: **depth decides how much to discover, budget decides
how much to show, the §6 ranking decides what survives truncation.**

**Revealed preference (emergent).** The requested depth is itself an importance
signal, so the read emits a low-weight `probed` fiber (`invocation --probed-->
file`, §3) carrying the tier. Files the agent repeatedly deep-probes accrue density
and surface more readily — the system learns the agent's attention map for free,
at a weight too low to dominate organic edit/assert signal.

### 7.2 Run it in parallel — it's genuinely concurrent here

Read bytes come from `fs.readFile` over the RuntimeFs RPC against the materialized
working tree (`read.ts`); fibers live in the gad-store DO. **Different services**,
so the two round-trips overlap rather than serialize:

```ts
const [content, prov] = await Promise.all([
  fs.readFile(absPath), // materialized worktree (fs RPC)
  budget(gad.provenanceForFile({ path, head }), PROV_BUDGET_MS), // gad-store DO
]);
```

Wall-clock is `max(read, density)`, not the sum. **Gotcha to preserve:** this is
true parallelism only while content stays off the gad-store DO. If read bytes
were ever served from `readGadFileAtState`, both calls would hit the same
single-threaded DO and you'd lose it. Keep content on fs/blobstore, provenance in
gad-store — which is how it is built today; don't "consolidate" them.

### 7.3 Breathing room: a standalone budget + speculative warm

The budget is **decoupled from the single read's I/O latency** — the provenance
block is consumed by the model's _next generation_ (seconds away), not by the
read, so a deliberate `PROV_BUDGET_MS` ceiling (tens–low-hundreds of ms) is the
right scale, not ~1ms. Two mechanisms give density that room:

- **Speculative warm (primary).** On `turn.opened` — and again while the model is
  generating — precompute provenance for the files the session is likely to touch
  next (its recent touch-set neighborhood, recently-edited files on the head, the
  open task's files) into a short-lived cache:

  ```sql
  CREATE TABLE gad_provenance_cache (
    head TEXT NOT NULL,
    path TEXT NOT NULL,
    touch_version INTEGER NOT NULL,  -- bumped as the session's touch-set grows
    rendered_json TEXT NOT NULL,     -- the ranked, ready-to-attach block
    created_at TEXT NOT NULL,
    PRIMARY KEY (head, path, touch_version)
  );
  ```

  Warm hot files at the `context` tier: a request **≤ `context`** is then served
  as a cheap subset of the cached block (O(1)); only `trace` misses and computes
  inline. So the budget rarely bites for the common depths. The cache is keyed by
  `touch_version` so a hit is only reused while the session's context hasn't moved
  on; it is disposable (drop = recompute), never authority.

- **Graceful degrade (the rare miss).** If neither warm nor the budgeted inline
  query is ready in time, return content now with a one-line "provenance ready —
  `provenance("path")`" hint, and write the computed block to
  `gad_provenance_cache` for next time. Crucially, **only write `included` fibers
  for what was actually shown** — degrade → write nothing → reinforcement stays
  exactly consistent with what the agent saw.

### 7.4 Ordering & determinism

Compute density against the **pre-read** fiber state, then write this read's own
`observed`/`probed` (and any `included`) fibers _after_ the query resolves — a
file's own read must not appear in its own attachment. The content fetch never
touches gad-store, and the DO serializes its own writes, so there is no
contention; just sequence query → attach → write.

The agent's `provenanceDepth`/`resultBudget` args live in the invocation request,
so they are logged and replayable like any tool input. Whether (and how much of)
an attachment appears is timing- and budget-dependent, but that composes cleanly
with replay determinism because **the log is the source of truth, not the
ranking**: the rendered block is an ephemeral runtime decision that is never
replayed, and we only ever persist `included`/`probed` fibers for what was
genuinely shown/requested.

### 7.5 Attachment shape

Semantic-first, compact, density-ranked, raw hunks omitted:

```
provenance · src/foo.ts (last edited 3 turns ago, 2 sessions)
  ● claim#42 "foo owns the retry budget" — supports claim#7 · 4 editing sessions touched it [●●●●○]
  ● session "rework-retries" edited L40–58 · recorded 2 claims you've touched this session [●●●○○]
  ● co-edited with src/retry.ts in 3 of last 5 edits [●●○○○]
```

The density meter is a coarse bucketing of `score`. Lines are emitted
densest-first and cut at `resultBudget`, so a tight budget keeps only the
strongest connections and a generous one shows the tail.

## 8. Hermeneutic claims

A claim is a node that can stand as an **entity**, a **predicate**, or a full
**statement**; a relations table connects them. Keep the existing `gad_claims`
columns; make subject/object nullable and add `claim_kind`.

```sql
-- in the CREATE TABLE (clean reset): claim_kind TEXT  -- entity | predicate | statement

CREATE TABLE gad_claim_relations (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  src_claim_id TEXT NOT NULL,
  relation TEXT NOT NULL,          -- supports | contradicts | about | refines | depends_on
  dst_claim_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_claim_rel_src ON gad_claim_relations(src_claim_id);
CREATE INDEX idx_claim_rel_dst ON gad_claim_relations(dst_claim_id);
```

This fills the never-built claim-edges slot. Claim↔trajectory links are fibers
(`asserted` / `cited` / `included`), not columns. Claim↔claim relations also emit
a `supports`/`contradicts`/… fiber so they participate in density.

Agent tools (thin emitters of the already-projected `knowledge.claim_*` events
plus `gad_claim_relations`):

- `record_claim({ text | subject,predicate,object, kind })`
- `relate_claims({ src, relation, dst })`
- `revise_claim` / `retract_claim`

The prompt frames this as the agent's durable working memory: record what you
learn, relate it, and it returns through density-ranked provenance later.

## 9. SQL-first surface

Ship tables + a few views, not a thick API:

- `provenance_for_file(path)` — view joining edit ops + trajectory + fibers.
- `fiber_graph` — flat fiber view for ad-hoc traversal.
- `claim_graph` — claims + relations + touching sessions.
- one `provenanceForFile` helper (the §6 scored, capped, ranked block) — the only
  piece that benefits from being a function rather than hand SQL, and the unit the
  warm cache and read-time attachment call.

Everything else the agent reaches via `gad.query` (read-only CTEs already
allowed). Prompt the agent that it can traverse provenance to arbitrary depth with
SQL when a goal warrants it.

## 10. What gets deleted

Done (committed): `gad_file_mutations`, `gad_file_change_hunks`,
`gad_file_observations`, `blameGadFileSnippet`, the orphaned `state.file_*` /
`memory.recalled` / `knowledge.{theory,claim_edge,contradiction}_*` event kinds,
and the dead `StatePayload` fields. Reads are re-homed onto `observed` fibers
(§3) rather than a bespoke observation table.

## 11. Phased plan

1. **Keystone + blame** — causality through `applyEdits`; `edited` fibers;
   `gad_fibers` + `gad_node_degree` + projection; edit-op blame view.
   _(Dead-table/kind deletion already landed.)_
2. **Read observation + claims** — `observed` fibers from the read tool;
   `record_claim`/`relate_claims`/`revise_claim` tools; `gad_claim_relations`.
3. **Density + attachment** — `provenanceForFile` (§6, capped 2-hop, `idf`/`norm`,
   turn/ordinality decay); mandatory `provenanceDepth`/`resultBudget` read args
   with the depth→cap mapping (§7.1); parallel + best-effort attachment (§7.2–7.5);
   `included` + `probed` fibers; `provenance()` tool; prompt guidance on triage.
4. **Speculative warm** — `gad_provenance_cache`; warm on `turn.opened` and during
   model generation; degrade-to-hint on miss.
5. **Tune** — decay λ, caps `K`/`M`/`N`, kind-weight ratios (esp. `included`),
   density buckets; verify cost on realistic logs. Add `gad_fiber_affinity`
   (periodic-pass materialization, §6.5) only if 2-hop ranking proves insufficient.

## 12. Resolved decisions & remaining tuning knobs

Resolved (locked for the build):

- **Decay:** logical, two clocks — turns-ago for session-recency, per-anchor
  ordinality for historical age; never the query-time wall clock; never global
  `log_events.seq`.
- **Weighting:** flat per-kind base weights; discriminate with `idf` (inverse
  degree) and `norm` (degree normalization); magnitude is never an input.
- **Cost:** capped 2-hop inline (`K`/`M`/`N`) + incremental `gad_node_degree` +
  in-memory touch-set; `gad_fiber_affinity` periodic-pass as the deferred lever.
- **Session identity:** trajectory-DAG position (event/branch-chain); no
  authoritative `session_id`; the column is a hint.
- **Attachment:** parallel with the fs read, on a standalone budget decoupled from
  read latency, best-effort, warmed ahead; reinforcement (`included`) only for
  what was actually shown.

Remaining knobs (need real logs, set defaults now, tune empirically):

- Decay constant λ and the `K`/`M`/`N` caps.
- Exact kind-weight ratios — especially how far below organic signal `included`
  sits. Default `included = 0.3`; watch for self-amplification (echo chamber) and
  lower it if the loop over-reinforces.
- Whether historical age should decay at all, or whether _any_ past co-edit stays
  full-weight and only `idf` discriminates. Default: mild historical decay **and**
  `idf`; revisit if "ever-connected ⇒ permanently relevant" turns out truer for
  this workload.
- `PROV_BUDGET_MS` and the warm-set selection heuristic (which files to
  precompute per turn).
- The depth→cap mapping (hops, `K`/`M`/`N`, expanded kinds per `blame`/`context`/
  `trace`), the hard ceilings on agent-requested depth/budget, and a sensible
  default `resultBudget`. The `probed` fiber weight tracks `included` (same
  echo-chamber treatment).
