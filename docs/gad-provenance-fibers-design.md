# GAD Provenance Fibers — Design Spec

Status: proposal. Pre-release; **no backward compatibility** — schema is reset on
bump (`GadWorkspaceDO.dropPersistenceTables`), so we add/rename freely.

**Durability boundary (reconciling with the review).** Resetting on bump is free
for the _runtime_ projections, but the review is right (`§5`, cross-cutting #5)
that memory which wipes on every bump is not long-term memory. This spec keeps
claims and fibers on the reset-on-bump substrate _deliberately_: within a schema
era they are durable working memory; across a bump they are gone. That is
acceptable only while pre-release. Graduating the knowledge ledger to survive
schema change — a durable sub-ledger or real migrations (review roadmap §7) — is a
**precondition for calling the memory pillar "real," not a later nicety.** V1
builds the loop; it does not yet claim cross-era persistence, and the prompt (§13)
must not promise the agent more permanence than the substrate delivers.

This spec turns GAD's existing ledger kernel into a single, queryable
**provenance graph** that joins the worktree VCS, the agent trajectory, and a
hermeneutic claim model — then surfaces it to the agent at read time as a compact
summary: **fibers for provenance, the existing FTS index for similarity recall, and
graph density to re-rank both** by relevance to the current session. It is the concrete plan behind the June 2026
GAD review (`docs/gad-system-review-2026-06.md`).

**Scope.** This spec operationalizes two of the review's three pillars — the VCS
(blame) and the memory/hermeneutic (claims) layers — unified on one graph. The
third pillar, durable task/goal/intent tracking (review §4 Move C, roadmap §5), is
**out of scope here**: the fiber model is built to absorb it later (an `intent`
anchor_kind plus `blocks`/`about`/`justified_by` fibers drop into §3–§6 without
reshaping them), but no intent producers, tables, or tools ship in this plan.
"One graph" is the eventual frame; this spec delivers its memory+VCS slice.

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
2. **Read-time provenance attachment** — on each read, attach a compact summary at
   the agent-requested depth (claims first, then sessions/files), ranked by
   relevance to the current session. Deeper exploration is on-demand.
3. **Two-source retrieval, density-reranked** — surface relevant context from two
   candidate sources — **fibers** (structural/causal: blame, edit lineage) and
   **similarity** (FTS recall over claims/messages/files, optionally steered by
   read-time keywords) — then order the union by **session density**: how strongly
   the current session connects to each candidate. Density is a _re-ranking signal
   on top_, never the sole gate, so a semantically relevant claim surfaces even with
   no structural path to it. The ranking sharpens as the session accumulates context.
4. **Hermeneutic memory** — a simple claims-as-nodes + relations model the agent
   uses as working memory, fiber-linked to the trajectories that touch it, and
   recalled by similarity + density (not only by structural reachability).
5. **SQL-first** — expose the graph as clean tables/views and prompt the agent
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

`observed` is the one **behavioral** soft signal: invocation → file, recording that
the agent read the file at all. It sits at the bottom of the weight ladder so it
nudges density without ever dominating organic edit/assert signal (the exact ratio is
a tuning knob, §12).

Note what is **deliberately absent**: no `included` fiber, and no `probed` fiber. An
earlier draft fed every _shown_ node back into its own future density (an `included`
Hebbian "showing strengthens showing" loop, gated only by a low weight) and recorded
the agent's requested tier as a `probed` revealed-preference signal. Both are cut as
over-engineering: co-access and attention are already legible from `observed` plus the
agent's real edits/assertions, without persisting extra self-referential edges that
the ranking then amplifies — and a low coefficient only slows a rich-get-richer loop,
it does not make it safe. Density is reinforced **only by the agent's real behavior**
— reads, edits, assertions — never by the system having shown something to itself or
by the agent's own budget dial.

### Schema

```sql
CREATE TABLE gad_fibers (
  id INTEGER PRIMARY KEY,
  event_id TEXT,                   -- organic fibers: the log event that asserted them; NULL for soft fibers (see below)
  kind TEXT NOT NULL,
  src_kind TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  session_id TEXT,                 -- denormalized hint: branch head at creation (not authority)
  invocation_id TEXT,
  turn_seq INTEGER,                -- creating turn's ordinal in its branch (for turn-decay)
  weight REAL NOT NULL DEFAULT 1,  -- defaulted from kind; a `weight` hook for future hand-boosts
  hits INTEGER NOT NULL DEFAULT 1, -- soft fibers: coalesced repeat count; organic fibers: always 1
  created_at TEXT NOT NULL
);
CREATE INDEX idx_fibers_src ON gad_fibers(src_kind, src_id);
CREATE INDEX idx_fibers_dst ON gad_fibers(dst_kind, dst_id, id);
CREATE INDEX idx_fibers_kind ON gad_fibers(kind);
CREATE INDEX idx_fibers_session ON gad_fibers(session_id);
-- Soft fibers coalesce instead of appending a row (and a log event) per read:
-- one counted upsert per edge identity within a session. Organic fibers keep one
-- row per event_id and never collide here (partial index covers soft rows only).
CREATE UNIQUE INDEX idx_fibers_soft_coalesce
  ON gad_fibers(kind, src_kind, src_id, dst_kind, dst_id, session_id)
  WHERE event_id IS NULL;
-- Organic fibers are idempotent per (event_id, edge) BY CONSTRAINT, not discipline:
-- replay/fork folds the same event under multiple heads and must not double-insert
-- the row or double-bump degree. INSERT OR IGNORE against this index drops the
-- duplicate — exactly how gad_state_transitions dedups, and the opposite of the
-- imperative check-before-insert the deleted gad_file_change_hunks path relied on.
-- (One event can emit several fibers — one `edited` per path — so event_id alone is
-- not unique; the edge tuple completes the key.)
CREATE UNIQUE INDEX idx_fibers_organic_ident
  ON gad_fibers(event_id, kind, src_kind, src_id, dst_kind, dst_id)
  WHERE event_id IS NOT NULL;

-- Incrementally maintained as fibers are created; powers the IDF/specificity and
-- normalization terms (§6.2) without a read-time COUNT. Counts *distinct*
-- counterparties — a new neighbor bumps it, a coalesced soft-fiber repeat does
-- not — so high-traffic nodes don't saturate idf toward uniform. **Symmetry rule:**
-- the prune pass (§6.5) that ages out soft fibers MUST decrement degree for any
-- counterparty whose last edge it removes; otherwise degree drifts monotonically
-- up, idf saturates toward uniform, and the specificity term silently dies.
CREATE TABLE gad_node_degree (
  node_kind TEXT NOT NULL,
  node_id TEXT NOT NULL,
  degree INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_kind, node_id)
);
```

**Two tiers, because reads are the hot path.** _Organic_ fibers
(`edited`/`asserted`/`cited`/`relate_*`) are real provenance: each is a projection
of one log event, replayable like every other projection, and **never pruned**.
Idempotency per `event_id` is a **DB constraint**, not a discipline: folding the
same event under multiple heads (forks, replay) hits `idx_fibers_organic_ident` and
`INSERT OR IGNORE` drops the duplicate, so the row is never double-inserted and
`gad_node_degree` never double-bumped. (The deleted `gad_file_change_hunks` path
left this to an imperative check-before-insert; that is exactly what we are not
repeating.)

_Soft_ fibers (just `observed`) are best-effort _signal_, not provenance. Every read
writes one. **That per-read DO write is accepted on purpose: recording that a read
happened _is_ the provenance we want here.** What they must not do is bloat the
canonical log — a hash-chained, replayed, forkable log event per read would inflate
it 10–100×. So a soft fiber lives **off the log** as a **counted upsert**
(`event_id IS NULL`, bump `hits`, refresh `turn_seq`) coalesced by edge identity
within a session via `idx_fibers_soft_coalesce`. Soft fibers are excluded from
integrity/replay and are **prunable** — aged out below a relevance floor on the
periodic pass that maintains `gad_fiber_affinity` (§6.5), which also keeps
`gad_node_degree` honest on removal (the symmetry rule above). Density (§6) reads
both tiers uniformly; a soft fiber contributes its kind weight scaled by a
_sublinear_ function of `hits` (bounded accumulation), while organic repeats compound
by adding rows (distinct `event_id`s).

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
deleted. Blame is a query over `gad_worktree_edit_ops` joined to the log and the
state-transition DAG. The row set is a plain join:

```sql
SELECT eo.path, eo.hunks_json, eo.kind, eo.old_content_hash, eo.new_content_hash,
       eo.output_state_hash, le.envelope_id AS event_id, le.causality_json, st.invocation_id
FROM gad_worktree_edit_ops eo
JOIN log_events le ON le.envelope_id = eo.event_id
LEFT JOIN gad_state_transitions st ON st.event_id = eo.event_id
WHERE eo.path = ?
ORDER BY le.seq DESC;
```

**But line-level blame is not a row filter — it is an interval problem, and the hunk
ranges are recorded in the coordinate space of _their own_ state.** A hunk that
replaced lines 40–58 at state S1 no longer lives at 40–58 once a later edit inserts
or deletes lines above it. So "who last changed line N at head H" is **not** "the
newest op whose recorded range contains N" — that test overlaps in the wrong
coordinate space and silently mis-blames after any earlier-in-file edit. This is the
offset composition `git blame` does, and it must be done here too:

1. **Order** the path's ops oldest→newest along the branch-chain to H — the DAG, not
   global `le.seq` (which is polluted by unrelated trajectories/channels, §6.3).
2. **Walk newest→oldest, carrying the query line back through each later op's offset
   delta.** Each `replace`/insert/delete shifts the lines below it by
   `(new_len − old_len)`; to test op _k_ against a line at H you map that line back
   through ops _k+1…latest_ into op _k_'s post-state coordinates, then check
   containment in op _k_'s new-side hunk. The first op whose mapped hunk contains the
   line is the answer; its `event_id` → `causality_json` / `invocation_id` is the
   producing turn/invocation.
3. **`write` ops reset identity.** A whole-file `write` (no hunks) is a coordinate
   barrier: every line of the new content is "changed by" that write, and recovering
   which lines actually survived it needs an on-demand
   `old_content_hash`→`new_content_hash` diff. Stop the backward walk at the most
   recent `write` unless a content diff says a line passed through unchanged.

`hunks_json` is the fast path (exact ranges, no rematerialization); the content-hash
diff is the fallback when a `write` or a hash mismatch breaks the hunk chain. Either
way it is a **bounded per-file computation at query time** — O(ops on this path), not
stored state — but it is the part of blame most likely to be wrong if treated as a
naive overlap, so it lives in a `blameLines(path, range, head)` helper, not inline
SQL.

**Non-agent transitions blame to "no trajectory."** Merge, snapshot-ingest, and any
human/panel edit carry no `causality`, so their `invocation_id` is null by design;
line-level blame still resolves the _state/event_ that changed a line, it just
reports no producing turn — it degrades to structure rather than lying.

## 6. Retrieval: provenance ∪ recall, re-ranked by session density

Retrieval has **three layers**, most-exact first:

1. **Provenance (fibers)** — structural, causal, exact: blame and edit lineage
   (§4–§5). Always correct, never "ranked away."
2. **Recall (similarity)** — FTS over `gad_memory_fts` (claims, messages, committed
   files), the index that already backs `memory_recall`. This is the **semantic**
   leg: it surfaces a relevant claim even when no fiber path reaches it. The read
   tool steers it with explicit `recallKeywords` (§7.1); absent those, the query is
   the file path plus the session's recent touch anchors.
3. **Density (re-ranking signal)** — spreading activation seeded from the session's
   **touch-set**, used to **order the union of (1) and (2)** by how strongly the
   current session connects to each candidate. Density is a re-ranker _on top_,
   **not** the gate: an FTS hit with no structural path still appears, it just sorts
   below an equally-similar claim the session already edited near.

So: **fibers for provenance, similarity for recall, density to re-rank.** The
bespoke graph does what it is uniquely good at (causal proximity) and does not try
to be the similarity engine.

**Density** itself = bounded 2-hop spreading activation, scoring connections that
are **specific, recent, and accumulated** above promiscuous ones.

`touch(S)` = the anchors the current session has touched (files edited/read, claims
asserted/cited, invocations). **It is not held in the agent loop.** Every touch is
already a fiber in the gad-store DO — we accepted the per-read soft write (§3) — so
the DO reconstructs `touch(S)` from its _own_ fibers, scoped to the session's
trajectory branch: the common (no-fork) path is a single indexed lookup on
`idx_fibers_session` (`session_id` = the session branch head, capped to the last
`K`); a mid-session conversation fork widens it to branch-chain reachability (§6.4)
only when one occurred. It grows as the session accrues fibers — which is why
ranking sharpens over a turn — with **no loop-side state to keep in sync across the
process/DO boundary.**

For a read of file `F`, the **structural** candidates are claims/sessions/files
reachable from `F`'s editing sessions (`… --edited--> file:F`, the claims those
sessions `asserted`/`cited`, the files they co-`edited`); the **similarity**
candidates are the FTS hits for `recallKeywords`/`F`. Density scores both.

### 6.1 Score

```
rank(C) = w_sim · sim(C)                          // FTS relevance; 0 if not an FTS hit
        + w_prov · idf(C) · Σ_{ paths p : touch(S) ⇝ C, len(p) ≤ 2 }
                              Π_{ edge e ∈ p }  w_kind(e) · decay(e) · norm(src(e))
```

- `sim(C)` — normalized FTS score (the recall leg); 0 for purely-structural
  candidates. `w_sim`/`w_prov` set the balance between "semantically on-topic" and
  "causally close to what I'm doing" (a tuning knob, §12).
- the second term is the spreading-activation **density**; it is 0 for an FTS hit
  with no path, so similarity alone can still surface a candidate — re-ranking, not
  gating.
- `w_kind(e)` — the flat per-kind base weight from §3.
- `idf(C) = 1 / log(2 + degree(C))` — **specificity**. A claim/file connected to
  _everything_ is background hum; one connected to exactly the sessions that
  touched `F` is signal. Read straight from `gad_node_degree`.
- `norm(X) = 1 / sqrt(outDegree_kind(X))` — **degree normalization**. Stops a
  50-file refactor (or a promiscuous bridge node) from flooding the touch-set;
  the cosine-style analogue of "don't let big diffs win."
- `decay(e)` — **logical, never the wall clock** (§6.3).

Density is a **re-ranking term, not a gate**: it reorders candidates the two legs
already surfaced; it never suppresses an FTS hit to zero visibility.

### 6.2 Weighting: flat per kind, discriminate by degree

Edit _magnitude_ (lines/hunks) is **not** a weight input — it is a poor proxy for
significance and structurally biases toward generated/vendored/bulk files.
Relationship depth instead emerges from **accumulation** (repeated edits compound
as more fibers) and **kind** (`edited` > `observed`). The only
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
`gad_fibers.session_id` column is a denormalized _hint_ (the session's trajectory
branch head at creation — stable across the session, since edit-commits move the
_worktree_ state head, not the trajectory branch): the no-fork common path filters
`touch(S)` by `session_id = <session branch head>` on `idx_fibers_session` with no
CTE; only an actual mid-session fork falls back to recursive branch-chain scoping
for canonical correctness.

### 6.5 Cost: bounded inline, with an offline escape hatch

The query must be **O(neighborhood), independent of total log size** — two
indexed join passes, not `RECURSIVE`:

- **Caps** (which also improve quality): seed = last `K` touches of the session;
  per-node fan-out = top-`M` neighbors by recency (high-degree nodes are
  low-signal per §6.2, so capping is free); candidates = top-`N` shown.
- **Maintained incrementally:** `gad_node_degree` (for `idf`/`norm`). The touch-set
  is the session's last-`K` fibers (one indexed lookup on `idx_fibers_session`, §6) —
  not a read-time `COUNT`, and not loop-held state to sync across the process/DO
  boundary.
- **Escape hatch for richer-than-2-hop ranking on large logs:** materialize a
  `gad_fiber_affinity` table from a _periodic server-driven pass_ — the same
  shape as the existing GC (`runGadGcMark/Sweep`) and memory-FTS reindex passes
  — and have the read look it up in O(1). (Note: the old `gad_index_jobs` queue
  is not in the live schema; this leans on the GC-style periodic-pass pattern, or
  a small job lane, not an existing one.) V1 does not need it; it is the named
  scaling lever, not a launch dependency.

## 7. Read-time attachment: agent-budgeted, parallel, best-effort, warmed

### 7.1 The mandatory tier and the item budget

`read` takes one **mandatory** argument — a deliberate, non-defaultable judgement
on every read — plus one optional steer:

- `provenance: "none" | "moderate" | "deep"` (**mandatory**) — the coarse budget for
  _this_ read: it sets both the **depth** (which of the §6 three layers to compute)
  and a **default item budget** — how many ranked items to render (`none` 0,
  `moderate` a handful, `deep` more). Budget is counted in **items, not tokens**: each
  item is one bounded `insight + handle` line (§7.5), so N items is a predictable size
  and the agent never has to calibrate a token number.
- `recallKeywords: string[]` (optional) — steer the similarity leg (§6 layer 2). If
  present, FTS recall queries these terms; if absent, it falls back to the path plus
  the session's recent touch anchors. A cheap way to say "while you're here, pull
  what we know about _retries_ / _this invariant_," independent of the file's own
  text.

**The tier stays mandatory on purpose.** Forcing the agent to name
`none`/`moderate`/`deep` on every read makes context-cost a conscious, per-file
decision instead of a default it never revisits — and the per-call cost of one small
argument is negligible against the value of that triage. The risk to guard is the
_opposite_ of overspend: a miscalibrated agent under-asking and **missing context it
needed**. So the posture is biased _toward_ doing work — `moderate` is the normal
choice, not `none` — and the prompt (§13) keeps a nonzero tier popular. The tier is a
_request within system bounds_, not authority: the runtime still enforces hard
ceilings on the per-tier block size and wall-clock (`PROV_BUDGET_MS`, §7.3), so
"always ask `deep`" cannot blow up compute or context.

Tiers map straight onto the §6 layers, scope, and caps:

| tier       | does                                                                                            | when                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `none`     | file content only — **no fiber queries, no recall**                                             | you know this file cold; a glance; a re-read                                        |
| `moderate` | blame (1-hop, §5) + FTS recall (steered by `recallKeywords`) + 1-hop density re-rank             | **the normal choice** — anything you're actually working with                       |
| `deep`     | `moderate` + full 2-hop density (§6) + claim-relation walk (`supports`/`contradicts`/`refines`)  | a file you're about to change with non-obvious ramifications; the hermeneutic walk  |

`provenance(path | query)` stays for deepening _without_ re-reading. The tier is
explicit per call — no implicit first-touch magic.

**What the tier renders — and what it withholds.** Content is always returned in full
(it honors the existing range args); the attachment is the tier's **item budget** worth
of top-ranked items (§6), densest-first. The low-ranked tail is **not dropped
silently** — it is *withheld but advertised*: every truncated section reports `K of M`
and the exact call to fetch the rest (§7.5, §9.2). This is the answer to "too low
starves, too high wastes": **keep the default item budget deliberately low** (cheap,
never wastes context) and make under-budget *recoverable* — the agent sees how much it
is not being shown and pulls more only when a thread looks live. Calibration stops being
fragile because under-budget is visible and one cheap call away, not a silent loss.

**Drill-down contract.** `provenance(target, after?)` — exposed as the tool and
reachable via eval (`gad.provenanceForFile({ path, head, tier, after })`) — returns the
next page of ranked items **plus the remaining count**: `{ items, shown, total,
nextCursor }`. So the agent can always (a) see exactly how much more detail exists and
(b) ask for it, at item granularity — deepening one item (`provenance("claim#42")`) or
paging the same file (`provenance("src/foo.ts", cursor)`). The auto-attachment is the
cheap first page; the API is unbounded paging on top of it.

**Every read leaves a trace.** Regardless of tier, the read emits one low-weight
`observed` fiber (`invocation --observed--> file`, §3); files the agent returns to
accrue density and surface more readily, at a weight too low to dominate organic
edit/assert signal. There is no per-tier signal — the tier is the agent's budget
dial, not something the graph records.

### 7.2 Run it in parallel — it's genuinely concurrent here

Read bytes come from `fs.readFile` over the RuntimeFs RPC against the materialized
working tree (`read.ts`); fibers _and_ the FTS recall index both live in the
gad-store DO. Content is a **different service**, so the two round-trips overlap:

```ts
const [content, prov] = await Promise.all([
  fs.readFile(absPath), // materialized worktree (fs RPC)
  budget(
    gad.provenanceForFile({ path, head, tier, recallKeywords }), // gad-store DO:
    PROV_BUDGET_MS,                                               // fibers + FTS + density, one round-trip
  ),
]);
```

Wall-clock is `max(read, attach)`, not the sum. The provenance/recall/density work
is **one** gad-store call — fibers and FTS are the same DO, so bundling them avoids a
second serialized round-trip. **Gotcha to preserve:** this is true parallelism only
while content stays off the gad-store DO. If read bytes were ever served from
`readGadFileAtState`, content would queue behind the attachment on the same
single-threaded DO and you'd lose it. Keep content on fs/blobstore, provenance+recall
in gad-store — which is how it is built today; don't "consolidate" them.

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

  Warm hot files at the `moderate` tier: a `none` or `moderate` request is then
  served as a cheap subset of the cached block (O(1)); only `deep` misses and
  computes inline. So inline compute rarely bites for the common tiers. The cache is keyed by
  `touch_version` so a hit is only reused while the session's context hasn't moved
  on; it is disposable (drop = recompute), never authority.

- **Graceful degrade (the rare miss).** If neither warm nor the inline query is
  ready in time, return content now with a one-line "provenance ready —
  `provenance("path")`" hint, and write the computed block to
  `gad_provenance_cache` for next time. The read still emits its `observed` fiber (it
  records that the read happened, which it did) — but there is nothing node-level to
  over-claim, since no `included`-style "we showed it" fiber exists anymore. The soft
  layer records what the agent _did_, never what a block _might_ have displayed.

### 7.4 Ordering & determinism

Compute the attachment against the **pre-read** fiber state, then write this read's
own `observed` fiber _after_ the query resolves — a file's own read must not appear in
its own attachment. The content fetch never touches gad-store, and the DO serializes
its own writes, so just sequence query → attach → write.

The agent's `provenance`/`recallKeywords` args live in the invocation request, so they
are logged and replayable like any tool input. Whether (and how much of) an attachment
appears is timing- and tier-dependent — and the `observed` fiber a read spawns
therefore depends on runtime timing (warm hit vs. miss vs. degrade) and on FTS index
state, so it is **not** a deterministic function of the log. Do not paper over this:
it is exactly why the soft tier is _soft_ (§3). Determinism is kept where it must be —
the **organic** graph (edits, claims, relations) is fully log-derived, replayable, and
the only thing `checkGadIntegrity` covers — while the soft layer is an explicitly
non-deterministic affinity signal layered on top, outside integrity and never
replayed. The rendered block is ephemeral and never persisted; the soft upsert records
only what was genuinely read, so it never claims more than the agent saw.

### 7.5 Attachment format

The block fuses three layers of signal, cheapest-to-richest, and **never
generates prose on the hot path** — semantics are _recalled_, not synthesized:

1. **Structural skeleton + handles** — file, edit recency, editing sessions,
   co-edited files, each carrying the short handle (`claim#42`,
   `session:retry-rework`, `state:9f2`, `file:retry.ts`) to chase. Cheap, faithful,
   and the query surface for follow-ons (§9.2).
2. **Derived structural signals that _read_ as insight** — hub-ness, coupling
   ("couples with retry.ts"), churn, staleness, and contradiction flags. Computed
   from the graph, deterministic, high value-per-token.
3. **Recalled claims** — the semantic flesh: claims surfaced by the **similarity
   leg** (FTS over `gad_claims`/messages/files, steered by `recallKeywords`) and
   **ordered by density**, taken verbatim — a past agent's already-distilled,
   provenance-anchored insight. Zero generation cost, verifiable, the
   highest-insight layer, and reachable even when no fiber path links it to this
   file.

Every line is **one insight + one handle**: it tells the agent something _and_
hands it the exact thing to query next. Items are emitted densest-first up to the
tier's **item budget** (`deep` shows more than `moderate`); whatever is withheld is
advertised as a `K of M` count with the `provenance(...)` call to page it (§9.2). The
block scales by tier (§7.1):

`moderate` (blame + recall + 1-hop density):

```
prov · src/foo.ts (edited 3 turns ago · 2 sessions · couples with retry.ts) · 4 of 17 items
● claim#42 "foo owns the retry budget" ·supports #7· 4 sessions touched it [●●●●○]
● ⚠ contradicts claim#7 "retries are caller-controlled" → provenance(claim#42)
● session:retry-rework edited L40–58 · recorded 2 claims you've touched [●●●○○]
● co-edited with src/retry.ts ×3 of last 5 edits [●●○○○]
  +13 more (8 claims · 5 files) → provenance("src/foo.ts")
```

`deep` expands the claim-relation graph (supports/contradicts/refines chains) and
the full 2-hop neighborhood around the file — most semantic, still entirely
claim-sourced. (`none` adds nothing — content only. The one-line `prov · …` form is
the §7.3 degrade fallback, not a tier.)

The density meter (`●●●●○`) is a coarse bucketing of `score`. Because claims are
sparse early and accrue over time, the block **degrades gracefully to structure
and bootstraps toward semantics** as the agent records memory. `provenanceForFile`
returns structured rows plus `shown`/`total`/`nextCursor`; the read attachment renders
the first page to this compact text, and the agent pages or deepens via the same
structured form.

## 8. Hermeneutic claims

A claim is a node that can stand as an **entity**, a **predicate**, or a full
**statement**; a relations table connects them. Keep the existing `gad_claims`
columns (`subject`/`predicate`/`object` are already nullable); add `claim_kind`.

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
(`asserted` / `cited`), not columns. Claim↔claim relations also emit
a `supports`/`contradicts`/… fiber so they participate in density.

Agent tools (thin emitters of the already-projected `knowledge.claim_*` events
plus `gad_claim_relations`):

- `record_claim({ text | subject,predicate,object, kind })` — **dedup-on-write.**
  Before inserting, FTS the claim text against existing `gad_claims` (the index is
  already maintained — `projectKnowledge` indexes every claim into `gad_memory_fts`)
  and, on a near-duplicate, return the candidate(s) so the agent `revise_claim`s or
  `relate_claims`es instead of forking a second near-identical node. Memory that
  compounds depends on claims being _found and revised_, not re-created; cold-start
  (sparse claims, weak density) is exactly when dup risk is highest, and FTS is the
  one signal that works there.
- `relate_claims({ src, relation, dst })` — relations are **agent-asserted**, not
  auto-detected: a `contradicts` edge exists because some agent recorded it. The
  attachment's "⚠ contradicts" surfaces a _previously asserted_ contradiction; the
  system does not infer them.
- `revise_claim` / `retract_claim`

The prompt frames this as the agent's durable working memory: record what you
learn, relate it, and it returns through similarity + density-ranked recall later.

## 9. SQL-first surface and follow-on queries

### 9.1 Surface

Ship tables + a few views, not a thick API:

- `provenance_for_file(path)` — view joining edit ops + trajectory + fibers.
- `fiber_graph` — flat fiber view for ad-hoc traversal.
- `claim_graph` — claims + relations + touching sessions.
- one `provenanceForFile({ path, head, tier, recallKeywords, after? })` helper — the
  §6 pipeline (structural candidates ∪ FTS recall, density-reranked) returning the
  item-budgeted page plus `{ shown, total, nextCursor }` — the one piece that benefits
  from being a function rather than hand SQL, and the unit the warm cache, read-time
  attachment, and drill-down (§9.2) all call.

Everything else the agent reaches via `gad.query` (read-only CTEs already allowed).
**Raw `gad.query` returns _unranked_ fibers:** the recall + density ranking lives
only in `provenanceForFile`, so an agent that drops to SQL gets traversal and exact
provenance but not the §6 ordering — use SQL to chase a specific handle, not to
re-derive the ranked block.

### 9.2 Follow-on queries

The attachment is a launchpad, not a self-contained report — it gives the agent
just enough to decide whether a thread is worth a turn, plus the handle to chase
it exactly:

- **The block always says how much it withheld.** Each section carries `K of M` and
  the exact call for the remainder, and `provenance(...)` returns `{ shown, total,
  nextCursor }` — so "is there more?" is never a guess. A low item budget is safe
  precisely because the missing detail is counted and one call away.
- **Every line is a query seed.** Its handle (`claim#42`, `state:9f2`,
  `file:retry.ts`) is a precise next query — no guessing what to ask.
- **Two mechanisms:** `provenance(path | claim | query, after?)` for guided deepening
  and paging (returns the next items + remaining count), and raw `gad.query` over the
  views (with your own `LIMIT`/`OFFSET`) for arbitrary traversal. We deliberately do
  not pre-masticate; the agent chases its own goal.
- **Exploration is itself a (soft) signal.** `provenance(claim#42)` and follow-on
  reads write `observed` fibers, so what the agent actually digs into becomes denser
  and surfaces more readily next time — weighted low so behavior nudges density
  without dominating organic edit/assert signal.
- **Hint the top thread, don't dump.** The block pre-writes the suggested next
  query for the one or two highest-signal items (a contradiction, a hub), so the
  agent spends a follow-on only when the cheap broad signal flagged something.

This is the cost model the mandatory budgets (§7.1) exist for: **cheap broad signal
on every read, expensive deep dives only where the signal warranted one.**

## 10. What gets deleted

Done (committed): `gad_file_mutations`, `gad_file_change_hunks`,
`gad_file_observations`, `blameGadFileSnippet`, the orphaned `state.file_*` /
`memory.recalled` / `knowledge.{theory,claim_edge,contradiction}_*` event kinds,
and the dead `StatePayload` fields. Reads are re-homed onto `observed` fibers
(§3) rather than a bespoke observation table.

## 11. Phased plan

1. **Keystone + blame** — causality through `applyEdits`; `edited` fibers;
   `gad_fibers` (+ `idx_fibers_organic_ident`) + `gad_node_degree` + projection; the
   offset-composing `blameLines` helper over edit_ops (§5).
   _(Dead-table/kind deletion already landed.)_
2. **Read observation + claims** — `observed` _soft_ fibers from the read
   tool (coalesced upsert, off-log, §3); `record_claim` (with FTS dedup-on-write) /
   `relate_claims` / `revise_claim` tools; `gad_claim_relations`; surface recorded
   claims through the existing FTS recall (`memory_recall` / the layer-2 leg).

   **Value gate before phase 3.** Phases 1–2 already deliver the differentiators —
   blame that works and agent-recorded claims that return on recall. Confirm _that_
   is visibly useful on real trajectories **before** building the §6 density engine,
   whose every knob (§12) can only be tuned on logs that do not exist yet. The honest
   baseline to beat is **FTS recall + working blame** (no spreading activation); if
   it suffices, the density re-ranker is an enhancement, not a launch dependency —
   treat phase 3 as a bake-off against that baseline, not a foregone build.
3. **Recall + density attachment** — the FTS recall leg (§6 layer 2) over the
   existing `gad_memory_fts`; `provenanceForFile` (§6: structural candidates ∪ FTS
   hits, density-reranked over a capped 2-hop neighborhood with `idf`/`norm` and
   turn/ordinality decay); the mandatory ternary `provenance` read arg (the whole
   budget) and optional `recallKeywords`, with the tier→cap mapping (§7.1); parallel +
   best-effort attachment (§7.2–7.5); `observed` soft fibers; `provenance()` tool;
   attachment format (§7.5); follow-on surface (§9.2); prompt guidance (§13).
4. **Speculative warm** — `gad_provenance_cache`; warm on `turn.opened` and during
   model generation; degrade-to-hint on miss.
5. **Tune** — decay λ, caps `K`/`M`/`N`, kind-weight ratios, the `w_sim`/`w_prov`
   recall-vs-density balance, `observed` weight, density buckets; verify cost on
   realistic logs. Add `gad_fiber_affinity` (periodic-pass materialization, §6.5)
   only if 2-hop ranking proves insufficient.

## 12. Resolved decisions & remaining tuning knobs

Resolved (locked for the build):

- **Decay:** logical, two clocks — turns-ago for session-recency, per-anchor
  ordinality for historical age; never the query-time wall clock; never global
  `log_events.seq`.
- **Weighting:** flat per-kind base weights; discriminate with `idf` (inverse
  degree) and `norm` (degree normalization); magnitude is never an input.
- **Cost:** capped 2-hop inline (`K`/`M`/`N`) + incremental `gad_node_degree` +
  a DO-derived touch-set (indexed lookup on `idx_fibers_session`, §6, not loop-held);
  `gad_fiber_affinity` periodic-pass as the deferred lever.
- **Retrieval architecture:** fibers for provenance (structural/causal), FTS
  similarity for recall (semantic), density as a **re-ranking signal** over the
  union — never the sole gate (§6).
- **Session identity:** trajectory-DAG position (event/branch-chain); no
  authoritative `session_id`; the column is a hint.
- **Attachment:** parallel with the fs read, on a standalone budget decoupled from
  read latency, best-effort, warmed ahead; the `observed` soft fiber records only
  what was actually read.
- **Budget unit & recovery:** the attachment budget is counted in **items, not
  tokens** (each item = one bounded `insight + handle` line); the per-tier default is
  deliberately low and **under-budget is recoverable** — every truncated section
  advertises `K of M` and `provenance(target, after)` pages the rest (returning
  `shown`/`total`/`nextCursor`). Withheld detail is counted and one cheap call away,
  not silently lost.
- **Fiber tiers:** organic fibers (`edited`/`asserted`/`cited`/`relate_*`) are
  log-backed, replayable, idempotent per `event_id` **by DB constraint**
  (`idx_fibers_organic_ident`), never pruned; the soft tier is just `observed` — an
  off-log, coalesced (`hits`), prunable affinity signal excluded from integrity/replay
  (§3). Reads write an `observed` fiber to the DO (accepted cost) but never append a
  per-read _log event_. No `included` self-reinforcement fiber and no `probed`
  depth-dial fiber — both cut as over-engineering (§3).
- **Determinism:** the organic graph is fully log-derived and replayable and is
  what `checkGadIntegrity` covers; the soft signal layer is explicitly
  non-deterministic (timing-dependent) and sits outside it (§7.4).

Remaining knobs (need real logs, set defaults now, tune empirically):

- Decay constant λ and the `K`/`M`/`N` caps.
- Exact kind-weight ratios, and the `w_sim`/`w_prov` balance between the recall
  (FTS) and density legs (§6.1). Keep `observed` well below organic edit/assert
  signal so behavior nudges but never dominates ranking.
- Whether historical age should decay at all, or whether _any_ past co-edit stays
  full-weight and only `idf` discriminates. Default: mild historical decay **and**
  `idf`; revisit if "ever-connected ⇒ permanently relevant" turns out truer for
  this workload.
- `PROV_BUDGET_MS` and the warm-set selection heuristic (which files to
  precompute per turn).
- The tier→cap mapping (hops, `K`/`M`/`N`, expanded kinds and per-tier **item budget**
  for `moderate`/`deep`), the default item budgets themselves, and the wall-clock
  ceiling (`PROV_BUDGET_MS`).
- The soft-fiber `hits` → weight curve (§3): density scales a coalesced soft fiber
  by a sublinear function of `hits` while organic fibers compound by row. Default
  `sqrt(hits)`; tune jointly with the `observed` weight.
- **Mandatory tier, biased toward spending.** The ternary `provenance` is the single
  mandatory budget (§7.1) and stays that way — the goal is a genuine per-call
  judgement, and one small arg is a negligible tax. The failure mode to watch is
  **under-asking**, not overspend: an agent that reflexively picks `none` and misses
  context. So the prompt biases toward `moderate`, and we instrument the tier
  distribution — if it collapses to `none`, the fix is stronger prompting toward a
  nonzero tier, not a silent default (which would hide the very judgement we want).
  The agent picks only the coarse depth tier; the item budget is a system default
  (low, recoverable via drill-down), so there is no fragile per-read number to
  calibrate. Scope is the agent read tool only, never the fs RPC or panel/programmatic
  reads.

## 13. Prompting the agent

The machinery only pays off if the agent wields the tier budget, the block, and the
follow-ons well. This is the system-prompt guidance — concrete, not aspirational.
Phrase it to the agent roughly as:

**Triage every read.** `provenance` (`none` | `moderate` | `deep`) is mandatory and
is your whole context budget for the read; treat it as a one-second judgement, not a
formality. **When in doubt, pick `moderate` — under-reading context costs you more
than a few tokens of provenance.**

- `none` only for files you know cold, glances, and re-reads where you want nothing
  but the bytes.
- `moderate` is your **default** — blame plus what we already know about this file
  (recalled claims, recent edits, couplings). Use it for essentially anything you're
  actually working with.
- `deep` before you change a file with non-obvious ramifications, or when you need
  the belief structure around it — contradictions, what a claim depends on. Richer
  and slower; reserve it for the few files central to the task.

Pass `recallKeywords` to steer recall beyond the file's own text — e.g. reading
`retry.ts` with `["budget", "idempotency"]` pulls what we know about those, not just
about the file. Reserve `deep` for the few files central to the task and stay at
`moderate` (or `none`) elsewhere. You are spending your own context window —
economize, but do not starve yourself of context that is already paid for in
provenance.

**Read the block as a launchpad, not a verdict.** It is intentionally partial — you
are shown a few top-ranked items and told `K of M`, the rest withheld but counted. Act
on it directly when it is enough; when a line flags something live — a ⚠ contradiction,
a hub, a claim you cannot reconcile — or when the `K of M` count says the detail you
need is probably in the withheld tail, chase it with the pre-written `provenance(...)`
call (it pages the remaining items and tells you how many are left) or your own
`gad.query`. Do not reflexively expand every read; follow only the threads that change
what you will do.

**Record what you learn as claims.** When you establish something durable about the
code — an invariant, an ownership boundary, a gotcha, a decision and its reason —
`record_claim` it and `relate_claims` it to what it supports or contradicts. This is
your memory: claims come back — recalled by similarity and density-ranked,
provenance-anchored — the next time anyone touches the relevant files. If
`record_claim` shows you a near-duplicate it already knows, **`revise_claim` or
relate to it instead of recording a second copy** — fragmented memory is weaker than
one claim that accretes. Recording a claim is cheap; re-deriving it next week is not.

**Trust but verify.** Provenance is recalled, not generated — a claim is a past
judgement with a handle, not ground truth. If it matters, follow the handle to the
trajectory or edit that produced it rather than taking it at face value.

**Take a degrade gracefully.** If a block degraded to a `provenance("path")` hint,
that is the system protecting your latency — call it if the file is important,
ignore it if not.
