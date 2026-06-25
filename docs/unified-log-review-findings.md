# Unified-Log Rewrite — Full Review Findings

## Status (2026-06-13, fix pass 3 — review of fix pass 2)

Fix pass 2 (another agent) was independently re-reviewed against this report.
Fix-pass-1 work verified INTACT (preimage v2, storage classes, append intent,
CH-3 deadline clock, CAP-5 deferral, IN-5 gate). Pass 2 closed all remaining
findings but introduced regressions/gaps, now FIXED in pass 3:

- **AL-6 (P1 regression) FIXED** — fix pass 2's config overlay
  (`{...cached, config: input.config}`) wiped the FOLD-derived roster on every
  reload (the vessel injects an empty sentinel roster), silently breaking
  channel tools after any eviction/reload. Added `overlayInputConfig` in
  agent-loop (input settings overlay, fold-owned `roster` preserved); fold
  cache uses it on both fast and tail paths. Regression test added.
- **CH-4 (P1 regression) FIXED** — `nextPendingRedeliveryAt` anchored on
  `MIN(created_at)+10s`, which never advances → once a call was >10s old the
  alarm re-armed every ~100ms for the call's lifetime (hibernation defeated,
  worse than the bug it replaced). Re-anchored on a swept-at marker that
  advances each sweep (`PENDING_REDELIVERY_INTERVAL_MS`, cleared when no calls
  pending). Regression test added.
- **AL-1a (compaction) FIXED** — (1) placement: `maybeCompact` ran only at the
  end of `handleIncoming`, where the just-arrived prompt has an open turn, so
  compaction never fired during an active session. Introduced a `settle()`
  chokepoint called by BOTH `handleIncoming` and `applyOutcome`, so compaction
  is checked at idle AFTER a turn closes. (2) the trigger is now an injectable
  `DriverDeps.compaction` the vessel sizes to the model (256KB default via
  `getCompactionTriggerBytes`) instead of a hard-coded 64KB. (3) `maybeCompact`
  is try/wrapped so a failing compaction append can't fail the delivery whose
  journal work already succeeded (AL-8 inverse wedge). Two tests added.
- **Stale-loop binding (regression-sweep) FIXED** — `handleIncoming`/
  `applyOutcome` operated on a `loop` binding that `runStep` may have dropped
  on a stale-append reload; `settle()` always re-fetches the live instance via
  `this.loop(channelId)` before maybeCompact/reconcile.
- **PF-2 (nested-fork over-projection) FIXED** — `materializePrefix` recursed
  with the local `forkSeq` as the parent cap; when the requested prefix ends
  below this node's own fork point it over-projected parent events into the
  child seed. Capped at `min(forkSeq, throughSeq)`.
- **PF-3 (floating promise) FIXED** — detached no-op rejection handlers on the
  parallel prompt/tool blob reads so an early credential suspend/throw can't
  strand them as an unhandled rejection.
- **AL-7 / CH-4 tests added**; **rpc-client** cosmetic indentation fixed.
- **CL-9 (dead refs) FIXED** — removed the stale `dirty-repo`/`vcs-ready`
  tsconfig path mappings, the e2e `STATEFUL_PANELS` block that booted the
  deleted panels, and the now-empty panel dirs.
- **CL-11 test breakage FIXED** — fix pass 2 switched the CLI to
  `vcs.unitStatus` but left `vcsCommands.test.ts` asserting the old
  `vcs.status` shape (3 failures); updated to the server-scoped contract.

Verification: `npx vitest run workspace packages src` = 350 files / 3126 tests
all green; root `tsc --noEmit` clean; per-package tsconfigs (agent-loop,
agentic-do, channel-policies, pubsub, harness) clean.

Accepted as-is (verifier-confirmed, no action): CL-6 (WorkspaceTreeScanner is a
reasoned partial derivation from the package graph + SKILL.md supplement);
PF-4 (replay-coalescing implementation correct, hook render-count test not
added — low risk). Deeper follow-up still open from Part I: the channel POLICY
fold must not read unbounded payload fields (the one remaining
spill-discipline gap, since channel payloads keep `oversizeInline:"spill"`).

---

Deep review of the complete uncommitted working tree (2026-06-12), covering the
unified-log program: gad-store v16 unified log, agent-loop/driver harness cut,
channel DO rewrite, and the GAD-native vcs (WS3). Scope: `git diff HEAD`
(238 files, +10,284/−47,529) plus 36 untracked paths (agent-loop, pi-core,
gadVcs, effect-executors, vcsService, channel-policies, etc.).

Method: 8 finder passes (two line-by-line scans, removed-behavior audit,
cross-file caller tracing, reuse, simplification, efficiency, altitude) →
~45 deduplicated candidates → independent per-candidate verification against
the actual code. Verdicts: **33 CONFIRMED, 3 PLAUSIBLE, 1 REFUTED (with a real
residual), 4 unverified-but-evident**. Root `tsc --noEmit` is clean; the test
suite was green per the implementation log — the findings below are precisely
the class of problem a green new-surface test suite cannot catch.

**Every finding in this document needs to be fixed.** Severities order the
work; they do not exempt anything.

## Status (2026-06-12, fix pass 2)

All Part II/III findings are now addressed in this working tree.

Completed coverage:
- **Build/vcs core:** CV-1 graph-materialized build paths; CV-2 is superseded
  by the explicit-ref design ruling (`contextId` is not a build selector);
  CV-3 atomic CAS materialization with existing-file validation;
  CV-4 unchanged snapshot fast path, stat parallelism, and ensureFresh
  coalescing.
- **Merge/history:** MG-1 asymmetric diff3 conflicts; MG-2 merge retry guard
  and true pre-merge abort behavior; MG-3 head-aware vcs log and git bridge
  export.
- **Unified log/driver:** AL-1 compaction producer plus static storage classes;
  AL-3 hash preimage v2 and shared canonical JSON/hash helpers; AL-4/AL-5
  typed append-error handling; AL-6 config overlay/cache invalidation; AL-7
  form-effect failure mapping; AL-8 journal-boundary dedup.
- **Channel/pubsub:** CH-1 keyed delivery serialization; CH-2 explicit append
  idempotency intent; CH-3 single deadline clock; CH-4 exact-deadline alarms.
- **Capabilities:** CAP-1 confirm/approval routing; CAP-2 ask_user tool;
  CAP-3 web tools wired; CAP-4 silent-agent tools and allowedTools; CAP-5
  deferred capability waits; CAP-6 byte-accurate web offsets; CAP-7 abort and
  timeout propagation.
- **Refs/transports:** IN-1 GAD ref validation/migration errors; IN-2 JSON
  optional args; IN-3 ctx-head worker/DO rebuilds; IN-4 exact panel resource
  cache serving; IN-5 head-write authorization; IN-6 serve-cache invariant for
  code loading; IN-7 GAD dogfood self-update messaging.
- **Performance/cleanup:** PF-1 SQL log limits; PF-2 prefix-reused projection
  replay; PF-3 blob text LRU and parallel prompt/tool/credential fetches;
  PF-4 replay-batched chat projection; CL-1..CL-11 cleanup/reuse items.

Verification run in this pass: targeted vitest suites for dogfood, fs
sandboxing, build refs, workerd manager, vcs services, diff3, gad-store,
agent loop/driver, channel DO, agentic chat replay, model-call executor,
channel policies, and `pnpm type-check`.

---

## Part I — Architectural themes

The 40+ findings are not random; they cluster into recurring patterns. Fixing
the pattern (a mechanism, an invariant, a single owner) fixes the category and
prevents recurrence. This is the cleanliness-discipline lens: every theme below
is a place where a *convention* was used where a *mechanism* was needed.

### Theme 1 — Blob spilling must become a set of clear, static decisions

**Design direction (per project owner): eliminate optional/size-threshold
spilling entirely in favor of explicit per-field storage decisions.**

The current model has three spill behaviors: force-spilled paths
(`DEFAULT_FORCE_JSON_REF_PATHS`), size-threshold spilling (>128KB), and inline.
Folds never hydrate refs, so any fold-read field that spills silently turns
into a `StoredValueRef` pointer object and the fold misreads it. The defense is
a comment in `stored-values.ts` ("emitters of fold-critical events must keep
those fields small") — pure discipline, no enforcement.

This convention has now failed **four times**:

1. `message.started` `$.payload.request` force-spilled → renamed to
   `modelRequest` to dodge the path (fixed during E2E).
2. `system.event` `$.payload.details` force-spilled → credential flow blinded;
   fixed by un-force-spilling + "mirror fold-critical fields at top level"
   (fixed during E2E).
3. **AL-1 (this review, confirmed):** `system.compaction_recorded`
   `$.payload.replacement` is force-spilled; the fold requires an array;
   compaction is a permanent no-op.
4. **AL-1c (this review, confirmed latent):** the fold reads
   `details.roster` and `details.connectSpec`, which size-spill past 128KB;
   rosters now carry per-method JSON-Schemas, so a busy channel can blow the
   threshold and silently lose every channel tool (the exact "74-call
   memory_recall flail" pathology, again).

**Required redesign — no "maybe spilled" fields anywhere:**

- Every event kind declares its payload fields in one of exactly two storage
  classes:
  - **inline** — bounded by schema, always present in the envelope, the ONLY
    class the fold may read;
  - **reference** — *always* a content-addressed ref (even when tiny, so there
    is one code path), never read by the fold, hydrated only by executors/UI.
- Encode-time validation **rejects** an oversized inline field with a hard
  error at the emitter (the bug surfaces at the write site, attributable, in
  tests) instead of silently spilling (the bug surfaces as corrupted fold
  state, far away, in production).
- The fold can then be statically audited: it reads only inline fields, by
  construction. `hydrateStoredValueRefs` disappears from the fold path
  entirely; the size threshold and `DEFAULT_FORCE_JSON_REF_PATHS` are deleted.
- Migration inventory (fields the fold currently reads that must become
  schema-bounded inline): `payload.replacement` (compaction — likely becomes a
  reference + an inline summary the fold uses, see AL-1 fix), `details.roster`,
  `details.connectSpec`, the credential mirror fields, `recvEnvelopeId`s,
  turn/message ids. Everything bulky (model requests, tool results, file
  bodies, replacement entry arrays) is class *reference*.

### Theme 2 — One idempotency/append contract for the log

The unified log's value is that `appendLogEvent` is the single write path with
hash-chain integrity. The rewrite then punched four inconsistent holes in it:

- `ChannelLog.append` swallows content collisions **by regex on the error
  string** and silently returns the journaled original, for every
  deterministic-id appender including call terminals (AL-2).
- The agent driver's `applyOutcome` treats *any* stale-append error — including
  a plain head conflict where its events are genuinely new — as "already
  journaled" and throws away a completed outcome (AL-5).
- Credential-wait system events use envelope ids that are not unique per
  occurrence, so a legitimate second wait collides fatally (AL-4).
- The hash preimage itself is ambiguous (no field separators), so the
  integrity check the whole scheme rests on can be sidestepped (AL-3).

**Required mechanism:** an explicit append intent on `appendLogEvent`:

- `intent: "idempotent-by-id"` — client retry semantics; on id collision return
  the journaled original (what panel publishes need). Only this intent gets
  first-write-wins.
- `intent: "exact"` (default) — content collision is a hard integrity error
  (what call terminals, system events, and driver appends need).
- Typed error results (`head-conflict` | `id-collision` | `replay-mismatch`)
  instead of string matching, so callers can distinguish "retry against new
  head" from "already settled" correctly.
- Envelope ids for recurring system events get an occurrence discriminator
  (turn id, attempt counter, or wait sequence).
- Preimage fixed with length-prefixed fields (see AL-3) — a persistent-format
  decision that must land **before** this log format ships.

### Theme 3 — Finish the ref-model migration at the edges

`getBuild` accepts only HEAD / `state:...` / `ctx:...`, but the git-SHA era
survives at every boundary: the shell pin-by-commit UI, `ref:` fields in
natstack.yml, the worker-pinning API and its docs, persisted worker instances
(IN-1). Explicit `ctx:` refs work as targeted build selectors; `contextId`
itself is runtime/file-state identity and must not be treated as a build ref.
**Required:** one ref grammar, validated at every entry point, with either a
translation layer or an explicit loud migration for git-SHA inputs;
tuple-with-optionals (not union-of-tuples) arg schemas plus a null-normalization
fix in the dispatcher.

### Theme 4 — Capability parity must be restored (the harness cut dropped features silently)

The policy layer for approval/ask-user/fork exists and is tested in agent-loop,
but the *wiring* — tool registration, method registration, target resolution —
was never done: approval prompts (CAP-1), ask_user (CAP-2), web tools (CAP-3),
silent-agent file tools + `allowedTools` (CAP-4), compaction (AL-1), deferred
capability approvals (CAP-5). The deleted 6,954-line integration test and the
deleted extension tests were the only things asserting these behaviors; their
replacements test the new mechanisms, not feature parity. **Required:** restore
each capability (individual fixes below) and add a feature-parity test that
enumerates the user-visible agent capabilities (approval prompt renders,
ask_user round-trips, web_search callable, compaction fires) rather than the
plumbing.

### Theme 5 — Alarms: keep them, but only ever as exact-deadline timers

Question raised in review: *why rely on alarms at all — doesn't every relevant
activity wake the DO via some incoming request?*

Answer: inbound requests cover **triggering** work, but three things have no
inbound edge, and the alarm is the only durable timer a DO has:

1. **Future-dated work.** Retry backoff (`nextAttemptAt`), credential expiry,
   call `deadlineAt`, dedup-key TTLs. Nothing external arrives at those
   moments; without an alarm the deadline fires only when the *next unrelated*
   request happens to arrive — possibly never (an abandoned channel must still
   expire its pending calls).
2. **Orphan recovery after eviction or crash.** The pump's in-flight work
   (e.g. a 60s model stream) is *outbound*; if workerd evicts or crashes the
   isolate mid-effect, there is no client whose retry will arrive — the user is
   idle, waiting. The lease-expiry alarm is what resurrects the DO and
   redispatches the leased row. This is the heart of hibernation-first:
   requests append + an immediate in-process pump continuation does the work in
   the happy path; **the alarm is purely the recovery/deadline backstop**.
3. **At-least-once redelivery.** A panel that received a method call and then
   hard-crashed sends nothing back; only a timer can re-deliver.

So alarms are not a code-convenience accommodation — they are load-bearing.
The defect found in this review is alarms used as **periodic polling** instead
of exact deadlines: the channel DO arms a 60-second sweep whenever any rpc
participant row exists, forever (CH-4), and the redelivery sweep is a fixed
15s cadence rather than deadline-derived. **Required invariant, to be written
into `DurableObjectBase` docs and enforced in review:**

> An alarm is always set to the exact earliest future deadline derivable from
> durable state (`MIN` over lease expiries, `nextAttemptAt`, `deadlineAt`,
> `connected_at + STALE_MS`, TTL expiries). A DO with no future deadline has
> **no** alarm. Fixed-interval polling alarms are forbidden.

The agent driver's outbox already gets this right (`earliestDueAt()` is
lease-aware); the channel DO must be brought to the same standard.

### Theme 6 — Locking/freshness invariants need structure, not flags

The boot deadlock was fixed with `freshness: "serve"`, an options flag whose
invariant ("DO code serving must never drive a vcs scan") lives in call-site
discipline — and two gaps already exist (IN-6: `getWorkerCode` doesn't pass
it; the pinned-ref branch ignores it entirely). **Required:** a structurally
read-only code-serving surface (current EVs + build cache only) that workerd
code loading *must* use, so the scan path is unreachable from inside a commit
regardless of flags. Same theme: the build system's state is owned in two
places with bidirectional sync (CL-7).

### Theme 7 — Single implementations for load-bearing primitives

The envelope-hash recipe exists twice (CL-1/CL-2), canonical JSON twice in the
same package (CL-3), backoff twice with one copy dead (CL-4), keyed
promise-chain serialization four times with divergent rejection semantics
(CL-5), workspace-unit scanning twice with independent caches (CL-6), and the
unit-status fold twice (CL-10). Each duplicate of a load-bearing primitive is a
future split-brain. Consolidate as part of the related correctness fixes.

---

## Part II — Findings catalog

Severity: **P0** = breaks core functionality or persists a flawed format; fix
before commit. **P1** = real user-visible breakage or integrity hole; fix
before relying on the affected subsystem. **P2** = correctness under fault/
race, perf cliffs, security posture. **P3** = cleanup/debt. All get fixed.

IDs: CV=core vcs/build, MG=merge, AL=agent loop/log, CH=channel, CAP=capability
loss, IN=integration/refs, SEC=security, PF=performance, CL=cleanup.

---

### A. Build system & vcs core

#### CV-1 (P0, CONFIRMED) — State-graph builds resolve nonexistent entry paths
- **Where:** `src/server/buildV2/builder.ts:1682` (`prepareBuildEnv`), with
  `src/server/gadVcs/workspaceVcs.ts:365-379` (`discoverGraph`).
- **Problem:** `prepareBuildEnv` resolves the build entry via
  `remapPath(node.path, workspaceRoot, sourceRoot)`, assuming `node.path` is
  under `workspaceRoot`. The working-tree `discoverGraph` materializes graph
  checkouts under `buildSourcesRoot/graph-{hash}`, so `node.path` is NOT under
  `workspaceRoot`; the remap yields e.g.
  `.../build-sources/{buildDir}/state/build-sources/graph-…/panels/chat`,
  which does not exist → `resolveEntryPoint` (`builder.ts:3477`) throws
  "No entry point found". Where the path arithmetic coincidentally cancels,
  builds silently compile the *previous* graph-discovery checkout's bytes and
  cache them under the new EV buildKey — edits never appear until a
  rediscovery.
- **Why tests/E2E didn't catch it:** the previously-staged `index.ts` used
  `discoverPackageGraph(workspaceRoot)` directly (remap correct); on-disk
  build-sources from the morning E2E runs contain no `graph-*` checkouts. The
  materialized-graph change (~17:50) **postdates every recorded verified run**.
- **Fix:** make graph nodes carry their checkout root (or remap from the
  graph's materialization root, not `workspaceRoot`); add a build test that
  goes through `WorkspaceVcs.discoverGraph` → `prepareBuildEnv` with a real
  materialized checkout. **Re-run the boot + panel-build smoke before
  committing.**

#### CV-2 (SUPERSEDED) — contextId must not synthesize `ctx:` build refs
- **Current ruling:** `contextId` is runtime/file-state identity, not code
  provenance. A plain panel request with `contextId` and no `ref` must build
  main. Only an explicit `ref=ctx:<contextId>` or `ref=state:<hash>` targets a
  non-main build.
- **Do not restore:** fallback behavior that converts a context-bound panel into
  a `ctx:` build implicitly. If a `ctx:` ref is explicit and unresolvable, fail
  loudly as an invalid targeted build instead of silently substituting main.
- **Replacement test shape:** request a panel with only `contextId` and assert
  `getBuild(source, undefined)`; request the same panel with
  `ref=ctx:<contextId>` and assert `getBuild(source, "ctx:<contextId>")`.

#### CV-3 (P1, CONFIRMED) — CAS materialization trusts truncated files forever
- **Where:** `src/server/gadVcs/store.ts:502` (`materializeFileList`), also
  `:512` (link-failure fallback), `:515` (executable copy path).
- **Problem:** per-state build checkouts skip any file that exists
  (`fs.existsSync(absPath) → continue`) with no size/hash validation, and the
  non-hardlink fallbacks use plain `fsp.copyFile` (not atomic). A crash mid-copy
  leaves a truncated file that every subsequent materialization at that state
  treats as already-correct; the corrupt build output is then cached under the
  content-addressed buildKey and never self-heals.
- **Fix:** copy via temp file + `rename` (atomic); on the exists fast path at
  minimum compare size (cheap) against the CAS entry. Only the hardlink fast
  path may skip validation (inode identity is the validation).

#### CV-4 (P2, CONFIRMED) — Unchanged-tree check does a full scan + full file-table RPC per HTML request
- **Where:** `src/server/gadVcs/store.ts:322-338` (`snapshotDir` no-change
  check), reached from `panelHttpServer` → `getBuild` → `ensureFresh` →
  `commitHead` (`buildV2/index.ts:467`; `panelRuntimeRegistration.ts:1027`
  passes no `freshness` option).
- **Problem:** every panel HTML request triggers: a full workspace scan with
  one sequential `fsp.stat` per file, then a `listStateFiles` DO RPC that
  serializes the **entire** workspace file table (path/hash/mode for thousands
  of files) across the workerd boundary, then an O(n) JS diff — on the common
  *unchanged* path. `locked()` serializes concurrent commits but does not
  coalesce them; each runs its own scan+RPC.
- **Fix:** compute the local manifest stateHash via the shared
  `buildWorktreeManifest` (as `localState` already does at `store.ts:303`) and
  compare against `resolveWorktreeRef(head)` — one tiny RPC. Coalesce
  concurrent `ensureFresh` calls into one in-flight scan (promise dedupe).
  Parallelize the stat loop.

---

### B. Merge engine & vcs history

#### MG-1 (P0, CONFIRMED — verified by execution) — diff3 silently merges overlapping edits
- **Where:** `src/server/gadVcs/diff3.ts:109-115`.
- **Problem:** chunk "activation" requires `chunk.baseStart <= cursor`. When
  ours' chunk `[1,4)` is active at cursor 1 but theirs' `[2,3)` is not, the
  one-sided branch applies ours and jumps the cursor to 4; the next iteration
  sees theirs' chunk as `baseStart(2) <= cursor(4)` and applies it too —
  **both edits land sequentially, reported as a clean merge**. Executed repro:
  `diff3Merge('a\nb\nc\nd\ne\n', 'a\nZ\ne\n', 'a\nb\nT\nd\ne\n')` →
  `{ok:true, text:'a\nZ\nT\ne\n', conflicts:0}` where git produces conflict
  markers. Existing tests only cover overlaps starting at the same base line.
- **Impact:** silent content corruption in the vcs merge path — the publish
  path (`ctx→main`) and the pull path (`main→ctx`). Worst possible failure
  class for a vcs.
- **Fix:** a chunk is consumed only if its full base region `[baseStart,
  baseEnd)` is ≥ cursor at application time; a chunk whose base region was
  partially consumed by the other side is an overlap → conflict. Add the
  executed repro plus asymmetric-overlap cases (containment, partial overlap
  left/right) to `diff3.test.ts`.

#### MG-2 (P1, CONFIRMED) — Merge lifecycle is not re-entrant; retries corrupt state
- **Where:** `src/server/gadVcs/workspaceVcs.ts:429-441` (`mergeHeads`), with
  `:448` (up-to-date path), `:452` (clean path), `:499` (conflict
  materialization); `vcsService.ts:155-184` (no guard either).
- **Problem:** `mergeHeads` starts with a raw `snapshotDir(targetDir)` and
  never checks `getPendingMerge` (contrast `commitHead`, which converts a
  pending merge into a proper merge resolution). After a conflicted merge
  (markers materialized, head NOT advanced, pendingMerge parked):
  - Retrying `vcs.merge` commits the **conflict-marker tree** as a plain
    `state.snapshot_ingested` on the target head, then diff3s with the marker
    tree as "ours" → nested markers on any remaining conflict.
  - The `up-to-date`/`clean` retry paths return **without clearing** the parked
    pendingMerge, which the next ordinary `commitHead` then consumes as a
    forced merge resolution with the stale `theirsStateHash` as parent —
    wrong history.
  - `abortMerge` after a re-conflicted retry restores the *marker* tree (the
    new oursStateHash), not the true pre-merge tree.
- **Fix:** `mergeHeads` must begin with `getPendingMerge(target)`: if pending,
  refuse ("merge in progress: commit or abort") — same UX as git. Clear
  pendingMerge on every terminal outcome of a merge attempt. Make `abortMerge`
  restore the snapshot taken *before the first* merge attempt (store it in the
  pending-merge record).

#### MG-3 (P1, CONFIRMED) — vcs log is main-only and blind to merges; git bridge exports the wrong history
- **Where:** `src/server/gadVcs/workspaceVcs.ts:669-671` (`readVcsLog`);
  `gitBridge.ts:98` (`exportHead`), `:114-116` (marker lookup).
- **Problem:** `readVcsLog` hardcodes `head = VCS_MAIN_HEAD` and filters
  `payloadKind === 'state.snapshot_ingested'`. Consequences:
  1. `vcs.log` never shows merge commits or merge resolutions
     (`state.merge_applied`) on any head.
  2. `GitBridge.exportHead(head, gitDir)` takes transitions from
     `readVcsLog` regardless of its `head` argument (head is only used for the
     marker key) — exporting any non-main head exports **main's** history.
  3. The incremental-export marker lookup has no missing-marker guard:
     `ordered.findIndex(...) === -1` → `+1` → `0` → the **entire history is
     re-exported as duplicate commits** (reachable via a marker written on a
     different head, or a log exceeding the 10,000-row slice).
- **Fix:** `readVcsLog(head, …)` parameterized by head; include
  `state.merge_applied` (callers can filter); `exportHead` reads the head it
  was given; treat a missing marker as an explicit error or full-export-into-
  empty-dir-only condition.

---

### C. Unified log integrity & agent driver

#### AL-3 (P0, CONFIRMED) — Hash-chain preimage is ambiguous; integrity check can be sidestepped
- **Where:** `workspace/packages/agentic-protocol/src/log-envelope.ts:60`
  (`computeLogEnvelopeHash`), duplicated at
  `workspace/workers/gad-store/index.ts:1369` (`computeEnvelopeHash`).
- **Problem:** preimage is `${prevHash}${logId}${head}${seq}${json(semantic)}`
  with no separators or length prefixes. `prevHash` is fixed-width 64-hex
  (unambiguous), but logId/head/seq are raw-concatenated: head `'v1'`+seq `23`
  and head `'v12'`+seq `3` produce byte-identical preimages; same ambiguity at
  the logId/head boundary. A contiguous run is shift-invariant (seq 23,24,25
  under `'v1'` ≡ seq 3,4,5 under `'v12'`): every hash and prevHash link
  verifies. `checkLogIntegrity` groups by stored columns, sorts by the stored
  `seq`, and `verifyLogEnvelopeHash` re-derives from stored columns — nothing
  re-derives position. So stored head/seq columns can be relabeled onto a
  fabricated head without tripping any chain, gap, or hash check. With
  `ctx:`+hex head naming and digit-suffixed heads, collisions are concretely
  constructible.
- **Why P0:** this is a **persistent-format decision**. Every event appended
  with the ambiguous preimage bakes the weakness into stored data; fixing later
  means a migration that rewrites every hash chain.
- **Fix:** length-prefix each field (e.g.
  `len(logId):logId|len(head):head|seq|hash`) or any unambiguous encoding, plus
  a format-version byte for future evolution. Single shared implementation
  (see CL-1/CL-2/CL-3) used by both the async protocol path and the sync
  gad-store path. Migration: bump schema, refold/rehash on upgrade (replay
  infrastructure already exists).

#### AL-1 (P1, CONFIRMED) — Compaction is doubly broken (and the spill convention is the root cause)
- **Where:** (a) no producer: `{kind:"compact"}` exists only in
  `agent-loop/src/commands.ts:40` and `step.ts:451` — zero dispatch sites in
  agentic-do, workers, or tests; HEAD's pi-runner wired `CompactionTrigger`
  (0.8× context window) at `pi-runner.ts:765`, deleted. (b) fold-blind:
  `step.ts:466` emits the replacement entry array at `payload.replacement`;
  `$.payload.replacement` is in `DEFAULT_FORCE_JSON_REF_PATHS`
  (`stored-values.ts:54`) and `forceJson` spills unconditionally; the driver
  encodes before append and folds the encoded envelope
  (`agent-loop-driver.ts:207-221,243`), so `fold.ts:274`
  `Array.isArray(StoredValueRef)` is always false → **compaction would no-op
  even if dispatched**. (c) latent same-class: `fold.ts:295` reads
  `details.connectSpec`, `fold.ts:313` reads `details.roster` — both
  128KB-size-thresholded; rosters now include per-method JSON-Schemas.
- **Impact:** long-lived channels grow until model-context errors become
  permanent (every prompt retries, exhausts attempts, channel is bricked);
  busy channels can silently lose all channel tools (roster spill).
- **Fix:** (a) a compaction producer in the driver — after each turn close,
  estimate context size (tokens or bytes of `buildModelContext`) and dispatch
  `compact` past a threshold; (b) per Theme 1, make the fold-read shape of
  compaction inline-by-schema: e.g. `payload.keepEntryIds` + summary text
  inline (bounded), full replacement entries as class-reference for executors;
  (c) roster/connectSpec become schema-bounded inline (cap description/schema
  sizes at the emitter with a hard error) — covered by the Theme-1 redesign.

#### AL-4 (P1, CONFIRMED) — Repeat credential wait permanently wedges the turn
- **Where:** `workspace/packages/agentic-do/src/agent-loop-driver.ts:455,495`
  (`suspendOnCredential`, no try/catch); `agent-loop/src/ids.ts:85-87`
  (`ids.systemEvent` — no occurrence counter); expiry payload at driver
  `:434,465,472`.
- **Problem:** credential-wait events use envelope ids
  `sys:cred:{channel}:{provider}:started/:resolved` — unique per credKey, NOT
  per occurrence — with wall-clock `expiresAt` in the payload. A second wait
  for the same credKey in the same lineage (first wait expired via
  `credential.wait_expired`, user prompts again, key still missing; or key
  revoked later) re-appends the same id with different content. The gad store
  correctly throws (`id collision with different content`, gad-store
  `:1549`, or `replay has already-applied events after a new suffix`,
  `:1555`). `suspendOnCredential`'s append has **no catch** (unlike `runStep`
  :165-174 and `applyOutcome` :387-399), `dispatchRow`'s try only wraps
  `executor.execute`, and the pump swallows the rejection (`.catch(()=>{})`
  :565). Result: outbox row stays leased, `recordFailure` never runs, the row
  redrives at every 10-minute lease expiry, re-suspends, re-collides — the
  message terminal never journals, `inFlightModelCall` persists, the turn is
  open forever, and no connect card is republished. Self-heals only if the
  user happens to connect the credential anyway.
- **Fix:** (1) make credential system-event ids unique per occurrence (include
  turn id or a wait sequence number); (2) wrap `suspendOnCredential`'s append
  in the same stale-state handling as `runStep` (reload + retry once); (3) per
  Theme 2, surface typed append errors so this class of "no catch on an append
  path" is findable by type-checking rather than runtime.

#### AL-5 (P1, CONFIRMED) — Completed effect outcomes discarded on head conflict; whole effect re-executes
- **Where:** `workspace/packages/agentic-do/src/agent-loop-driver.ts:388`
  (catch), `:76-86` (`isStaleStateAppendError` matches BOTH error kinds),
  `:392` (row delete), `:278-292` (reconcile re-derives), `:303-319`
  (concurrent dispatch), `:232` (expectedHeadHash captured at call-build time).
- **Problem:** `applyOutcome` catches any `isStaleStateAppendError` — which
  matches both `id collision with different content` (effect genuinely already
  settled) and plain `log head conflict` (the outcome events are NEW; an
  unrelated append simply moved the head) — and in both cases deletes the
  outbox row, reloads the fold, reconciles. For a head conflict the terminal
  was never committed, so reconcile re-derives the still-pending effect with
  `attempts=0` and the pump **re-executes the entire effect**: duplicate model
  call cost and re-streamed deltas; for mutating local tools (maxAttempts=1,
  side effect already performed) duplicated side effects. Interleaving is
  real: `dispatchDue` runs rows via `Promise.all` with `expectedHeadHash` read
  before cross-DO awaits, and inbound `handleIncoming` appends race the
  outcome append at await points. `runStep` retries its append after reload
  (`APPEND_RETRIES=1`); `applyOutcome` never does, though outcome items are
  deterministic and would succeed against the new head.
- **Fix:** distinguish the two errors (Theme 2 typed errors). Head conflict →
  reload fold, recompute `expectedHeadHash`, retry the outcome append (same
  loop as `runStep`). Id collision → current already-settled handling. Also
  capture `expectedHeadHash` as late as possible (immediately before the gad
  call).

#### AL-6 (P1, CONFIRMED) — Stale fold-cache config: new tools/prompts silently never reach the model
- **Where:** `workspace/packages/agentic-do/src/agent-vessel.ts:566-627`
  (`ensurePromptArtifacts`, drop at `:626`), contrast `updateSettings`
  `:503-511`; `fold-cache.ts:103-118` (`loadState` fast path and tail path
  both reuse cached config); `step.ts:53-56,204` (model request hashes and
  tool gating read `state.config`); `model-call.ts:299-303` (executor fetches
  by request hash).
- **Problem:** when prompt/tool hashes change, `ensurePromptArtifacts` calls
  only `driver.dropLoop()` — it does **not** delete the fold-cache row
  (`updateSettings` does both). The next `loop()` →
  `foldCache.loadState` fast path returns the persisted state including its
  baked-in old config (`systemPromptHash`/`toolSchemasHash`/`activeToolNames`);
  `input.config` is consulted only when building a *fresh* state. Since the
  driver rewrites the fold-cache row on every append, the fast path almost
  always hits — so changed prompts and newly advertised channel tools never
  reach the model until `updateSettings` or a cold refold. The `config.changed`
  event (`step.ts:430-449`) that would patch the folded config has zero
  non-test producers. Realistic trigger: a panel joins the channel and
  advertises methods after first activity — exactly the roster-refresh flow
  this rewrite added.
- **Fix (altitude):** stop persisting derived config in the fold state, or
  overlay `input.config` over cached state on every `loadState` (config is an
  input, not folded history). Minimal patch: `ensurePromptArtifacts` deletes
  the fold-cache row like `updateSettings`. Better: `loadState` always returns
  `{...cached, config: input.config}` — removes the entire bug class including
  future config fields.

#### AL-7 (P1, CONFIRMED) — Failed approval forms loop forever (effect-id prefix mismatch)
- **Where:** `workspace/packages/agent-loop/src/step.ts:731-735`
  (`effectFailedStep` strips only `inv:`); `ids.ts:108`
  (`form:{approvalId}`); `effects.ts:161-179` (kind `channel_call`);
  `agent-loop-driver.ts:523-534` (`failEffect`), `:151-156` (reconcile);
  `effects.ts:207-209` (re-derivation).
- **Problem:** a permanently failing approval-form channel_call (target
  unreachable — which is currently *always*, see CAP-1) reaches
  `effectFailedStep`, which computes `invocationId = "form:{approvalId}"`
  (only `inv:` is stripped), misses `pendingInvocations`, and returns EMPTY: no
  `approval.resolved`, no invocation terminal, no turn close. The approval
  stays pending, so the very next reconcile re-derives the effect with a fresh
  outbox row (`attempts=0`); dispatch fails again — **infinite
  dispatch/fail/reconcile loop**, turn never terminates, channel hammered.
- **Fix:** `effectFailedStep` handles the `form:` prefix → append
  `approval.resolved {granted:false, reason:"delivery-failed"}` (fail-closed)
  + a diagnostic. Add an exhaustiveness guard: every effect-id prefix that
  `derivePendingEffects` can produce must have an `effectFailedStep` mapping
  (a unit test enumerating prefixes is enough).

#### AL-8 (P2, REFUTED as filed; residual defect CONFIRMED) — Redelivered compacted prompts wedge delivery retries
- **Where:** `step.ts:357-363` (`alreadyIngested` reads
  pendingPrompt/steeringQueue/`state.entries`), `:451-473` (compact keeps
  `entries.slice(-8)`); `agent-loop-driver.ts:76,165` (`APPEND_RETRIES=1`).
- **Original claim (refuted):** post-compaction prompt redelivery would open a
  duplicate turn. It cannot: the re-emitted batch uses deterministic ids
  (`recv:…`, `turn:…:opened`, `msg:…`), and gad's lineage-scoped envelope-id
  idempotency replays the prefix / rejects the divergent `message.started` —
  journal-level dedup holds.
- **Residual (real):** the redelivered append *errors* (collision or
  replay-prefix mismatch), the driver's single stale-fold retry reproduces the
  same error, and the channel delivery wedges in a retry loop instead of
  no-oping. Once compaction works (AL-1), this fires on at-least-once
  redelivery of any compacted-away prompt.
- **Fix:** move ingestion dedup to the journal boundary (Theme 2): on append
  failure for a `prompt`/`steer` command whose recv envelope id is already in
  the *log* (not the fold window), acknowledge the delivery as a no-op. Don't
  tie exactly-once ingestion to how much history compaction retains.

---

### D. Channel DO & pubsub

#### CH-1 (P1, CONFIRMED) — Module-level delivery chains break FIFO across channels
- **Where:** `workspace/workers/pubsub-channel/broadcast.ts:24,30`
  (module-scope `deliveryChains`/`emitChains`, keyed by participantId only),
  `:55-58` (`cleanupDeliveryChain` deletes unconditionally); callers at
  `channel-do.ts:1391` (evictStaleParticipants), unsubscribe, fatal-delivery
  cleanup. `workerdManager.ts:36,229`: all DO facets of a class share one
  worker/isolate, so all channels share these maps.
- **Problem:** participant `panel:X` subscribed to channels C1 and C2 (normal
  for the chat UI): C1's cleanup deletes the shared entry while C2's chain
  tail is mid-replay → C2's next emit starts fresh from `Promise.resolve()`
  and races ahead of the still-draining replay (ordering violation —
  the exact guarantee the streaming-UI fix depends on). Conversely, while the
  entry exists, C1 and C2 serialize on one chain: cross-channel head-of-line
  blocking (one slow subscriber delivery in C1 delays C2's emits).
- **Fix:** key the maps by `{channelId}:{participantId}` (or hold them as
  instance fields on the channel DO). Cleanup then naturally scopes to the
  channel. Use the shared keyed-serializer helper from CL-5.

#### CH-2 (P1, CONFIRMED) — ChannelLog.append swallows divergent duplicates for every deterministic-id appender, by error-string regex
- **Where:** `workspace/workers/pubsub-channel/log-store.ts:135-148`; funnel:
  `channel-do.ts:277` (`appendDurable`); affected appenders: `calls.ts:351,374`
  (settle terminals `terminal:{id}`), `calls.ts:252` (callMethod started);
  unaffected (no messageId): presence `channel-do.ts:414`, ui.feedback
  `:1263`, progress outputs `calls.ts:455`.
- **Problem:** the catch regex-matches
  `/log envelope id collision with different content/u` and silently returns
  the journaled original — first-write-wins applied to *call terminals and
  system appends*, not just retrying panel publishes. A divergent duplicate
  terminal (success vs error from racing executors — the race the
  implementation log says still exists) is silently swallowed: the second
  writer proceeds believing *its* outcome was journaled. Run 14's "raced
  duplicate terminal rejected by the gad integrity check, agent recovered
  honestly" behavior is gone. Correctness is also coupled to gad-store's exact
  error wording: rewording the message reverts retried publishes to the
  permanent per-participant delivery-wedge this fix addressed.
- **Fix:** Theme 2 — `intent: "idempotent-by-id"` passed explicitly by the
  publish API path only; terminals/system appends use `intent: "exact"` and
  keep hard collision errors. Typed errors end the regex coupling.

#### CH-3 (P1, CONFIRMED) — Three uncoordinated clocks on the call lifecycle; double execution constructible
- **Where:** `workspace/packages/pubsub/src/rpc-client.ts:989-1014`
  (hardcoded 120s watchdog; deletes `executingMethods` dedup at `:996` before
  the terminal submit settles; redelivery dedup checks at `:946-947`);
  `channel-do.ts:1312-1314` (15s sweep while any pending_calls row exists);
  `calls.ts:554-569` (expiry from journaled `deadline_at`, only when caller
  passed `timeoutMs`), `:86-88,131-133` (redelivery cutoff from preserved
  created_at). `deadlineAt` appears nowhere in `packages/pubsub/src` — the
  client never sees the journaled deadline.
- **Problem:** a legitimately long method (>120s: a build, browser automation)
  is aborted by the fixed client watchdog, which deletes the dedup entry; the
  15s sweep redelivers; the redelivery passes both dedup checks and the method
  **executes again** (the aborted-but-cooperative first execution may still be
  running) — doubled side effects, racing terminals for the `terminal:{id}`
  slot (a race CH-2 then hides). A caller's `timeoutMs > 120s` cannot be
  honored. (Correction vs the original candidate: there is no 5-min default
  expiry; expiry is deadline_at-only and the sweep does read journaled state —
  the broken legs are the fixed 120s client clock and dedup-delete-before-
  terminal.)
- **Fix:** single ownership: deliver the journaled `deadlineAt` with the call;
  the client derives its abort budget from it (default only when absent);
  delete the dedup entry only after the terminal submit settles (or keyed by
  attempt); the channel redelivers only past `deadlineAt`-derived points.
  This is the "call state machine" consolidation — one clock, three readers.

#### CH-4 (P2, CONFIRMED) — Idle channels wake every 60s forever; hibernation defeated
- **Where:** `workspace/workers/pubsub-channel/channel-do.ts:1288-1295`
  (`nextParticipantSweepAt` returns `now+60s` whenever any rpc participant row
  exists), `:1297-1310` (`scheduleNextAlarm`), `:1317-1353` (alarm re-arms
  unconditionally at `:1352`); constants `:57,59`
  (`PARTICIPANT_STALE_MS`=5min, interval=60s).
- **Problem:** one open chat panel (fresh heartbeat) keeps every subscribed
  channel DO waking every 60 seconds indefinitely to run a no-op eviction
  sweep — the hibernatable-WS design never gets a quiet period >1 minute.
  This is the Theme-5 anti-pattern: a polling alarm where a deadline exists in
  durable state.
- **Fix:** `nextParticipantSweepAt = MIN(connected_at) + PARTICIPANT_STALE_MS`
  over rpc participants (the exact moment the *earliest* participant could
  become stale) — idle channels then wake at most once per staleness window.
  Apply the Theme-5 invariant to every `scheduleNextAlarm` source (the 15s
  pending-calls sweep should likewise be deadline-derived once CH-3 lands).

---

### E. Capability losses from the harness cut

#### CAP-1 (P1, CONFIRMED) — Approval prompts can never reach the user; supervised modes silently auto-deny
- **Where:** `workspace/packages/agent-loop/src/effects.ts:161-179`
  (`approvalFormEffect`: target `{kind:'user', id:'user'}`, method
  `'confirm'`); `calls.ts:272-275` (target resolved by literal pid);
  chat panel registrations `useAgenticChat.ts:704-795` (`feedback_form`,
  `feedback_custom`, `set_title`, `inspect_card`, `persist_agent_model`,
  `inline_ui`, `ui_prompt` + tool methods — no `confirm`);
  `rpc-client.ts:962-979` (unknown method → method_not_registered);
  `agent-vessel.ts:871-885` (`routeInvocationTerminal`: any error terminal
  with purpose approval-form → `{kind:'approval', granted:false}`).
- **Problem:** two independent breaks: (1) no participant has pid `"user"` —
  panel channel membership is keyed by stable `slotId`, while `rpc.selfId`
  is only the current runtime entity — so the call settles instantly with
  "Target user not found"; (2) even with a correct target, no client registers
  `confirm`. Either way the error terminal resolves as `granted:false`: with
  tool-approval level 0 or 1 every gated tool is **silently denied, no prompt
  ever rendered**. (Default level 2 is why E2E runs didn't hit it.)
  `createApprovalSchema` exists in pubsub with zero production callers — the
  intended UI contract was never wired. Note interaction with AL-7: if the
  failure surfaces as an effect failure instead of an error terminal, it loops
  forever rather than auto-denying.
- **Fix:** define the approval-form contract end-to-end: resolve the target
  from the roster (the human participant's actual pid — roster metadata knows
  `kind:'user'`); register a `confirm` method in the chat panel rendering an
  approval card (the deleted `approval-gate.ts` + `createApprovalSchema` are
  the spec); fail-closed with a *visible* diagnostic message when no user
  participant is present. Add a feature test: level-1 channel + gated tool →
  approval card renders → grant → tool runs.

#### CAP-2 (P1, CONFIRMED) — ask_user is dead code; agents cannot ask the user questions
- **Where:** `agent-loop/src/policies/index.ts:21` (safe-list), `:171`
  (`askUserPolicy`) — the only `ask_user` references in the repo. Vessel
  registry: `agent-vessel.ts:643-647` (memory_recall + `getLoopTools`); base
  tools: `agent-worker-base.ts:82-93` (six file tools); overrides
  (gmail `:249`, silent `:43`) add no ask_user; no panel advertises it as a
  channel method.
- **Problem:** the policy that rewrites `ask_user` invocations exists and is
  safe-listed, but no tool named `ask_user` is ever registered, so the model
  never sees it. The deleted `ask-user.ts` extension (structured questions,
  options, multiSelect, feedback_form round-trip) has no functional
  replacement. Agents that need mid-task user input cannot get it.
- **Fix:** register an `ask_user` tool in the vessel base (schema from the
  deleted extension), routed through the askUserPolicy → channel feedback_form
  (the chat panel still registers `feedback_form`). Feature test: agent calls
  ask_user → question card renders → answer returns to the loop.

#### CAP-3 (P1, CONFIRMED) — Web tools preserved but unwired; agents have no web access
- **Where:** `workspace/packages/harness/src/web/index.ts:109`
  (`createWebTools(deps)`) — referenced only by its own test. HEAD's caller
  (`pi-runner.ts:1302`, `createWebToolsExtension`) was deleted. No vessel,
  worker, or `getLoopTools` override wires it; `meta/AGENTS.md` still
  documents web tools.
- **Problem:** no agent has `web_search`/`web_fetch`/`web_read`. Research
  tasks fail or degrade into tool-flail.
- **Fix:** wire `createWebTools` into the vessel base tool registry (deps:
  egress fetch port, blobstore, credential probes — all available on the
  vessel). Gate by config if some agents shouldn't have web. Then fix CAP-6
  and CAP-7 (latent bugs inside these tools) as part of the same change.

#### CAP-4 (P1, CONFIRMED) — Silent agents lost all file tools; `allowedTools` config is dead
- **Where:** `workspace/workers/silent-agent-worker/index.ts:43-45`
  (`getLoopTools` returns only `[say]`, no `super.getLoopTools()`); `:9`
  (`SilentAgentConfig.allowedTools` declared, never read). HEAD's
  `createRunner` kept the standard tool set and honored allowedTools
  (default: all + say).
- **Fix:** `return [...await super.getLoopTools(channelId), say]`, filtered by
  `allowedTools` when set (and decide whether `allowedTools` may exclude
  `memory_recall`, which is currently force-registered ahead of overrides —
  pick one semantics and document it).

#### CAP-5 (P2, PLAUSIBLE) — Deferred-RPC deletion leaves capability approvals inline-held across user waits
- **Where:** deletion in `workspace/packages/runtime/src/worker/durable-base.ts`
  (~:309, deferred_requests + redrive removed); vessel http port
  `agent-vessel.ts:425-433` hardcodes `{deferred:false}`;
  `egressProxy.ts:969-1000` (interactive raw-egress approval);
  `tests/e2e/credential-park-resume.e2e.test.ts` deleted (the only park/resume
  e2e).
- **Problem:** a DO→server call that triggers an interactive capability prompt
  (egress domain approval, panel permission) is now held inline across the
  user's think time; eviction mid-wait loses the in-flight grant. Partial
  compensation exists and is real: effects retry via the outbox, and
  `capabilityGrantStore` persists session/repo/version grants, so a retried
  effect finds `hasActive()` without re-prompting. Residual gaps: `once`
  grants re-prompt; the inline wait wedges the executor for its lease; the
  vessel never sets `deferrable` even though rpcServer still supports it.
- **Fix:** either route capability-gated calls through the effect machinery
  (model the approval as a `credential_wait`-style deferred effect — fits the
  existing six-kind taxonomy), or restore a minimal deferrable flag on the
  vessel http port for known-interactive services. Re-create a park/resume
  test (eviction between prompt and grant) for whichever path is chosen.

#### CAP-6 (P2, unverified — review before wiring CAP-3) — web_fetch mixes UTF-16 char offsets with blobstore byte offsets
- **Where:** `workspace/packages/harness/src/web/index.ts:272` (reports
  `head.length` chars as "bytes"; directs continuation via byte-based
  web_read), `:230` (cached path compares byte size to char count).
- **Problem:** for non-ASCII pages the model is told to continue at a byte
  offset inside content it already saw; mid-codepoint reads decode U+FFFD
  garbage; fully-returned pages get reported as truncated.
- **Fix:** do all offset math in bytes (slice the UTF-8 buffer, not the
  string), or store+report char offsets consistently end-to-end.

#### CAP-7 (P2, unverified — review before wiring CAP-3) — web tools ignore AbortSignal and have no fetch timeout
- **Where:** `web/index.ts:258` (execute drops the `signal` param);
  `web/extract.ts` (RequestInit without signal/timeout).
- **Problem:** a hung remote server pins the tool invocation past turn
  cancellation; in the hibernation-first driver that holds the effect lease
  until expiry for no reason.
- **Fix:** thread the executor's AbortSignal into every fetch; add a default
  timeout (AbortSignal.timeout composed with the turn signal).

---

### F. Integration, refs & transports

#### IN-1 (P1, CONFIRMED) — Git-SHA refs still flow into getBuild from three surfaces
- **Where:** `getBuild` ref validation `src/server/buildV2/index.ts:379-389`
  (only `main`/`state:`/`ctx:`; no git→state translation anywhere).
  - (a) `src/server/appHost.ts:674` — the shell pin-by-commit UI
    (`HostTargetsSection.tsx:97-121`, placeholder "commit or ref") feeds the
    user-typed value straight in → any SHA throws `Unknown vcs ref`.
    (Rollback/"Pin previous" via `getBuildByKey` (`appHost.ts:766-784`) still
    works — only pin-by-commit is broken.)
  - (b) `appHost.ts:1329` and `packages/extension-host/src/service.ts:1319` —
    `decl.ref` from natstack.yml (any non-empty string; default "main") goes
    into getBuild at boot → declared SHA/branch refs error the unit;
    `resolveDeclarationRef` (`service.ts:1459-1463`) can even rewrite
    `main`→`master`, which then throws.
  - (c) `src/server/workerdManager.ts:118-120` + runtime client
    `workspace/packages/runtime/src/shared/workerd.ts:64-66` still *document*
    commit-SHA pinning; `instance.ref` flows raw into getBuild at
    `workerdManager.ts:510/633/841`, so SHA-pinned instances fail
    `loadWorkerCode` on next code load.
- **Fix:** one ref grammar (Theme 3): validate/normalize at each entry point
  with a helpful error ("git SHAs are no longer build refs; use state:… —
  obtain via vcs.log"); update the pin UI to offer vcs states; update docs and
  the workerd client JSDoc; add a migration/warning path for persisted worker
  instances with SHA refs (mark status with an actionable message rather than
  a generic build error).

#### IN-2 (P1, CONFIRMED) — vcs RPC optional args fail over every JSON transport
- **Where:** `src/server/services/vcsService.ts:88-94` (z.union-of-tuples for
  status/log/merge/abortMerge/pendingMerge);
  `packages/shared/src/serviceDispatcher.ts:28` (`normalizeArgs` returns early
  for non-ZodTuple, so wire `null` is never mapped back to undefined; reject
  at `:330-337`); `workspace/packages/runtime/src/shared/vcsClient.ts:104-118`
  (optionals passed positionally → `['main', undefined]` →
  JSON → `['main', null]`).
- **Problem:** `['main', null]` fails both union branches (length vs
  `z.string().optional()` rejecting null); even bare `vcs.status()` sends
  `[null]` and fails. Breaks: spectrolite `CommitStrip.tsx:70`,
  `MobileCommitButton.tsx:28`, and the documented agent DX
  `vcs.merge("main")` from any worker/DO/WS-panel transport. In-process
  dispatch preserves `undefined`, so `vcsService.test.ts` passes — the surface
  has plausibly never worked over the wire.
- **Fix:** replace unions-of-tuples with single tuples of `.optional()`
  /`.nullable()` params, AND fix `normalizeArgs` to normalize null→undefined
  for optional positions in non-tuple schemas too (the dispatcher-level fix
  protects every future service). Add a wire-shape test (JSON round-trip) to
  the service test harness so in-process tests can't mask this class again.

#### IN-3 (SUPERSEDED) — worker/DO code refs must be explicit
- **Current ruling:** workers and DOs follow the same rule as panels: no `ref`
  means main; `contextId` selects storage/files/state only. A worker or DO should
  run context-branch code only when launched or updated with
  `ref: "ctx:<contextId>"` (or an immutable `state:<hash>`).
- **Do not implement:** defaulting worker/DO build refs from `contextId`.
- **Replacement fix shape:** make the ergonomics/docs surface explicit `ref`
  when launching code created or edited in a context, and make rebuild/restart
  notifications target instances whose stored build ref tracks that exact head.
  Main-tracking instances should continue to update only from main advances.

#### IN-4 (P2, CONFIRMED) — Referer-less artifact serving can cross contexts; SPA catch-all masks missing chunks
- **Where:** `src/server/panelHttpServer.ts:400` (bare-source exact key checked
  before fallback), `:532-540` (`findResourceInAnySourceBuild` — newest build
  of ANY ref/context for the same source); `builder.ts:1856-1858`
  (`entryNames: "[name]"` — entry bundles NOT content-hashed; only chunks and
  assets are).
- **Problem:** the fallback's safety premise ("chunk names embed content
  hashes") does not hold for entry files (`bundle.js` exists in every build of
  a source). A referer-less entry request is served from the newest cached
  build of any ref/context → context A's panel can execute context B's (or
  main's) code with no error. Mitigation today: the normal loader carries
  `?contextId/?ref` via script referer, so exploitation needs a
  referer-stripped fetch (no-referrer meta in a user-authored panel, direct
  fetch, hard reload of the script URL) — reachable, not exotic. Also: a
  ref-pinned panel's chunk request can hit a bare HEAD build first via the
  `:400` exact-key shadow, and `servePanelResource` SPA-catch-alls a missing
  chunk as HTML (the original text/html MIME failure mode, still reachable).
- **Fix (altitude):** make resource URLs carry build identity by construction:
  content-hash entry names too (`entryNames: "[name]-[hash]"` with the HTML
  pointing at the hashed entry), or bake a `/state:{hash}/` path segment into
  the bundle's import base at build time. Then delete
  `findResourceInAnySourceBuild` and both referer parsers — the cache key
  becomes exact and three heuristics disappear. Never SPA-fallback a path that
  matches the chunk/asset naming pattern; return 404.

#### IN-5 (P2, PLAUSIBLE) — vcs.commit has no authorization gate; main is reachable on the null-context fallthrough
- **Where:** `src/server/services/vcsService.ts:44-50` (`headForCaller` falls
  through to `VCS_MAIN_HEAD` when `entityCache.resolveContext` is null/empty),
  `:109-138` (commit path, no permission check; policy allows
  panel/worker/do); only `merge` (`:163-177`) gates main to shell/server.
  Deleted: `workspacePushAuthorizer.ts` (required interactive
  `INTERNAL_GIT_WRITE_CAPABILITY` grant for *any* panel/worker/do workspace
  write).
- **Problem:** the old interactive gate is gone with no replacement decision.
  Normal panels/workers land on ctx heads (runtimeService assigns a contextId),
  but any caller whose entity record lacks a contextId (bootstrap window,
  race-before-activation, harness/extension paths) falls through to **main**:
  `commitHead(main)` snapshots the user's live working tree — including
  half-finished edits — advances main, and triggers rebuilds + meta config
  reload, silently. Verifier could not fully construct the reachability, hence
  PLAUSIBLE — but the missing gate is a fact.
- **Fix:** make it an explicit decision: (a) `commit` to main requires
  shell/server caller kind (mirror the merge gate) — entity callers may only
  commit to their own ctx head; (b) `headForCaller` returning null context for
  an entity caller is an **error**, not a main fallthrough. If panel-initiated
  main commits are ever wanted, reintroduce an interactive capability grant
  for exactly that path.

#### IN-6 (P2, CONFIRMED) — freshness:"serve" invariant has holes; boot-deadlock surface remains
- **Where:** `workerdManager.ts:841` (`getWorkerCode` — NO freshness option;
  siblings at `:936/:1928/:1984/:2204` pass it);
  `buildV2/index.ts:381-419` (pinned-ref branch never consults
  `options.freshness`: does resolveHead + discoverGraph →
  `materializeStateForGraphDiscovery` (`workspaceVcs.ts:283-286`) +
  contentHashesAt + buildUnit — all gad-DO dispatches), `:462-474` (the
  invariant comment + HEAD path).
- **Problem:** the "DO code serving must never drive a vcs scan" invariant is
  call-site discipline. `getWorkerCode` (dynamic worker host) misses it →
  un-pinned worker code load inside a commit window re-creates the exact
  silent boot deadlock; any ctx/state-pinned DO instance routes through the
  serve-exempt pinned path which dispatches to the gad DO regardless.
- **Fix:** Theme 6 — extract a read-only `CodeServingView` (current EVs +
  build cache; build-on-miss allowed but **no** head resolution, no scan, no
  gad materialization) and make all WorkerdManager code-loading call it. The
  flag then disappears; the invariant becomes structural. Until then: pass
  `freshness:"serve"` in `getWorkerCode` and honor it in the pinned branch.

#### IN-7 (P2, CONFIRMED) — Dogfood self-update is dead code with a misleading banner
- **Where:** `scripts/start-dogfood-server.mjs:380-394` (waits for
  `^\[mirror\]` lines), `:296-300` (`dogfoodGitUrl` ignores params, returns
  local repoRoot into `bootstrapWorkspace({gitRemoteUrl})`), `:459` (banner:
  "Edits … mirror back to this checkout"). The only `[mirror]` emitter was
  `packages/git-server/src/server.ts:720` — deleted;
  `src/server/index.ts:742` now logs "mirroring is unavailable".
- **Problem:** the self-development loop silently does nothing: agent edits
  accumulate in the workspace clone, the host checkout never updates, the
  server never restarts, and the banner actively claims otherwise.
  `tests/dogfood-server.test.ts` stays green (pure helpers only).
- **Fix:** decide: implement the vcs-side answer (subscribe to
  `state-advanced(main)` for `projects/natstack` paths + gitBridge export →
  host checkout fast-forward), or rip the self-update machinery + banner out
  and log "self-update unsupported under GAD vcs" loudly. Don't ship the
  misleading middle state.

---

### G. Performance & hibernation

(CV-4 and CH-4 above are also members of this family.)

#### PF-1 (P2, CONFIRMED) — readLog ignores `limit` in SQL; cold refolds are O(N²)
- **Where:** `workspace/workers/gad-store/index.ts:1419-1453` (no LIMIT
  clause; `.toArray()` of the entire remaining segment; JS truncation at
  `:1450`); consumer `agentic-do/src/fold-cache.ts:144-160` (PAGE=500).
- **Problem:** each 500-row page rematerializes and decodes all remaining rows
  of the segment → O(N²/500) on every cold refold (wake with stale cache,
  fork postClone, amnesia recovery — exactly the already-cold moments).
- **Fix:** push `LIMIT ?` into the SQL (per-segment, bounded by remaining
  budget), or iterate the cursor lazily and break at limit.

#### PF-2 (P2, CONFIRMED) — Projection replay refolds every fork head's full inherited prefix
- **Where:** `gad-store/index.ts:3999-4019` (`replayTrajectoryProjections`:
  per head, `readLog({limit:0})` materializes lineage root-first;
  applyProjections per envelope; one transaction). Compounded by PF-1.
- **Problem:** with H context forks of the workspace log, main's entire
  history is read, parsed, and re-projected H+1 times — on every schema
  migration and amnesia recovery.
- **Fix:** fold each distinct prefix once root-first; seed child-head
  projections by SQL `INSERT…SELECT` re-key of the parent's projection rows up
  to fork_seq (projections are keyed `(log_id, head)`; the fork path at
  `:1933-1946` already folds inherited lineage under the child key), then fold
  only each child's suffix. Stream rows instead of materializing lineages.

#### PF-3 (P2, CONFIRMED) — Every model call re-fetches every spilled blob; no digest memo
- **Where:** `effect-executors/model-call.ts:319-322` (hydrate full context
  per execute), `:299-303` (systemPrompt then toolSchemas awaited
  sequentially); `stored-values.ts:223-243` (parallel recursion, one
  `reader.getText` per ref, repeated digests re-fetched);
  `agent-vessel.ts:311-314` (blobstore port = bare RPC per digest).
- **Problem:** K spilled blobs × M model calls per turn RPCs, re-fetching
  immutable content; duplicate digests within one context fetched multiple
  times in the same call. (Hydration fan-out is parallel — the cost is RPC
  volume, not serialization.)
- **Fix:** digest-keyed LRU on the vessel's blobstore port (content-addressed
  ⇒ infinitely cacheable in-isolate; bound by bytes); `Promise.all` the
  prompt/tools/credential fetches. Note: under the Theme-1 redesign,
  model-context entries are class-reference and this hydration point remains —
  the memo is needed regardless.

#### PF-4 (P2, CONFIRMED) — Channel open is O(N²) in the UI during replay
- **Where:** `workspace/packages/agentic-chat/hooks/useChannelMessages.ts:
  166-246` (consume loop calls `rebuildFromChannelState()` per durable event,
  `:223,:244`, including replay phase), `:103-135` (full reprojection + React
  flush), `:141-148` (the delta path already coalesces via 33ms timer).
- **Problem:** opening a channel with N historical events does N full
  projections + N state flushes — visible first-paint delay on long channels,
  on every mount.
- **Fix:** during `wire.phase === 'replay'`, reduce without rebuilding and do
  one rebuild on transition to live; or route durable rebuilds through the
  existing `scheduleDeltaRebuild` coalescer.

---

### H. Cleanup, reuse & dead code

#### CL-1 (P3, CONFIRMED) — `semanticSlice()` duplicates `logEnvelopeSemantic()`
- `gad-store/index.ts:1373-1393` vs `log-envelope.ts:39-50`; identical 8-field
  object, comment admits "must match". Divergence breaks integrity
  verification for all new events. **Fix with AL-3:** one shared
  implementation in agentic-protocol (already imported by gad-store).

#### CL-2 (P3, CONFIRMED) — `computeEnvelopeHash` duplicates the hash recipe
- `gad-store/index.ts:1362-1369` vs `log-envelope.ts:52-62`; byte-identical
  preimage recipe, sync vs async sha256 the only difference. **Fix with
  AL-3:** export a shared `logEnvelopeHashPreimage(input): string`; both paths
  hash that one string.

#### CL-3 (P3, CONFIRMED) — Two canonical-JSON implementations in agentic-protocol
- `worktree-hash.ts:13-26` (`sortJson`/`stableJson`) vs `hash.ts:3-19`
  (`sortForCanonicalJson`/`canonicalJson`, not exported). Envelope hashing
  uses one, verification the other — they agree only by accident. **Fix:**
  export canonicalJson from hash.ts; worktree-hash re-uses it, keeping only
  the sync-sha256 addition.

#### CL-4 (P3, CONFIRMED) — `backoffMs()` is dead; live policy is an inline SQL string
- `effect-outbox.ts:74` (exported, unused except a dead import at
  `agent-loop-driver.ts:36`) vs the inline
  `MIN(30000, 500 * (1 << MIN(attempts+1,10)))` in `recordFailure` (`:180`).
  Values currently identical, but tuning the named function changes nothing.
  **Fix:** compute via `backoffMs(newAttempts)` in TS, bind as SQL parameter;
  drop the dead import.

#### CL-5 (P3, unverified but evident) — Keyed promise-chain serialization hand-rolled four times
- `broadcast.ts:44` (queueEmit), `:67` (queueDoEnvelope),
  `agent-vessel.ts:460` (sendOrderedSignal), `workspaceVcs.ts:134`
  (`locked()`). Rejection semantics already differ (workspaceVcs is
  wedge-proof via `then(fn,fn)`+tail-catch; the others rely on inner catches).
  **Fix:** one `keyedSerialize(map, key, fn)` helper (natural home:
  packages/shared or agentic-protocol) with defined rejection + eviction
  semantics; adopt at all four sites (CH-1's re-keying lands in the same
  change).

#### CL-6 (P3, PLAUSIBLE) — WorkspaceTreeScanner is a second unit scanner with an independent cache
- `src/server/gadVcs/workspaceTree.ts:23` (2s-TTL re-walk + package.json
  re-parse) vs buildV2 `packageGraph.ts:250-287` (graph discovery,
  state-trigger-fresh, `GraphNode.manifest`). Disagreement window right after
  unit create/delete; every new manifest field needs two parsers. Caveat (why
  PLAUSIBLE): the graph currently skips SKILL.md-only units and doesn't scan
  meta/agents/projects — deriving the tree from the graph requires extending
  graph discovery first. **Fix:** extend graph discovery to cover those unit
  kinds, then derive the launcher tree from the graph; keep only
  SKILL.md-frontmatter supplementation local.

#### CL-7 (P3, unverified candidate, evident from structure) — Build state dual-owned with bidirectional sync
- `buildV2/index.ts:299` closure (currentGraph/EvMap/ContentHashes/StateHash)
  ↔ `stateTrigger.ts` private fields, synced via `graph-updated` one way and
  `trigger.updateState()` the other; `persistEvState()` called from three
  sites. Every transition must remember both legs + persist. **Fix:** single
  owner (the trigger, or a small shared BuildState object) exposing getters;
  `rediscoverAt` becomes a method that updates/persists/emits in one place.

#### CL-8 (P3, CONFIRMED) — Dead shared-git-objects plumbing in security-critical fs path validation
- `contextFolderManager.ts:147-153` returns constant false, yet
  `fsService.ts:40,48-49,72,132-151,654,704,765-907` keeps
  `allowSharedGitObjects` / `escapedViaSharedGitObjects` /
  `isContextGitObjectsPath` threaded through `FsCallScope` (~10 call sites; the
  escape branch is unreachable). **Fix:** delete the hook, the option, the
  flag, and the helper; the check collapses to "symlink escapes sandbox ⇒
  throw".

#### CL-9 (P3, CONFIRMED) — Two unopenable about panels (dirty-repo rewritten; vcs-ready added)
- `workspace/about/dirty-repo/` (198 lines rewritten onto vcs surfaces) and
  `workspace/about/vcs-ready/` (new, untracked): zero openers anywhere
  (createAboutPanel pages are 'new'/'keyboard-shortcuts'/'help'/'about';
  both manifests are hiddenInLauncher). git-init was already deleted in this
  diff. **Fix:** delete both (preferred — re-create when a vcs-era gate flow
  exists and something actually opens it), or wire an opener and keep exactly
  one.

#### CL-10 (P3, CONFIRMED) — @workspace/git-ui fully orphaned (~10,676 lines)
- Zero `from '@workspace/git-ui'` imports anywhere; remaining references: a
  stale dep at `workspace/packages/tool-ui/package.json:20` and two doc
  comments. Builds against git-era staged/unstaged types the vcs doesn't have.
  **Fix:** delete the package + the tool-ui dep line (mirror the git-server
  deletion). If a vcs status UI is wanted later, it will be a rewrite anyway.

#### CL-11 (P3, CONFIRMED) — CLI re-implements the server's unit-status fold
- `src/cli/agent/vcsCommands.ts:58-70` (`toRepoStatus`) is line-for-line
  `gitService.ts:143-160`: same within-prefix predicate, same
  added/modified/deleted relabel, same dirty derivation — duplicated only
  because `git.status` hardcodes main and takes no head param. **Fix:** add an
  optional head param to the server's unit-scoped status; CLI calls it; delete
  toRepoStatus.

---

### I. Items tracked from the implementation log (not new findings; do not lose)

- Codex websocket thinking-content: WS upgrade either never starts or dies in
  workerd egress; next step is instrumented logging around
  `processWebSocketStream` + egressProxy upgrade handling (impl log, "CANARY
  STATUS"). Pills show the placeholder until fixed.
- Duplicate-terminal race noise across workerd instance swaps — AL-5/CH-2/CH-3
  fixes shrink this; re-evaluate after they land whether a dispatch fence is
  still needed.
- Trust layer still pins app/extension identity to per-repo git commits;
  re-key to GAD subtree hashes (deliberate follow-up).
- Legacy gad adapters (appendTrajectoryBatch, channel envelope APIs, fork*)
  slated for deletion.
- Git bridge: tree-level import only; per-commit history import deferred.
- Memory embeddings deferred; explicit `memory.recalled` promotion events
  reserved.
- Manual chat-panel E2E smoke (stream/approve/fork/interrupt + coding
  pipeline) still needs a human run — **now doubly required given CV-1/CV-2.**

---

## Part III — Fix order

**Gate 0 — before commit:**
1. CV-1, CV-2 (build breakage in unverified working-tree code) → then re-run
   the boot + panel-build + chat smoke.
2. AL-3 + CL-1/CL-2/CL-3 (hash preimage + single implementation) — persistent
   format; do not ship the ambiguous preimage.

**Gate 1 — before relying on the subsystems (user-visible breakage):**
3. MG-1 (diff3 corruption), MG-2 (merge re-entrancy), MG-3 (log/export head).
4. IN-2 (vcs args over JSON — unblocks agents + commit strip), IN-3 (context
   worker dev loop), IN-1 (git-SHA ref surfaces).
5. CAP-1 + AL-7 (approval flow end-to-end), CAP-2 (ask_user), CAP-3 (+CAP-6,
   CAP-7) (web tools), CAP-4 (silent agents).
6. AL-4, AL-5, AL-6 (driver wedges/duplication/stale config) — design these
   against the Theme-2 append contract rather than as three spot patches.
7. CH-1 (chain keying), CH-2 (append intent), CH-3 (call clocks).

**Gate 2 — correctness-under-fault, security posture, perf:**
8. Theme-1 spill redesign (subsumes AL-1; schedule as its own work item —
   protocol + emitters + fold + encode-time validation).
9. IN-5 (commit authorization decision), IN-4 (artifact identity), IN-6
   (code-serving surface), CV-3 (atomic materialization), AL-8 residual.
10. CV-4, CH-4, PF-1…PF-4 (hibernation/perf), IN-7 (dogfood decision).

**Gate 3 — debt:**
11. CL-4…CL-11, plus the Part-I invariants written into the relevant module
    docs (DurableObjectBase alarm rule, append contract, ref grammar, fold
    inline-only rule).
