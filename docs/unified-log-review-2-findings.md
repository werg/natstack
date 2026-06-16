# Unified-Log Rewrite — Review Pass 2 (fresh deep review, 2026-06-16)

Independent multi-agent review of the current uncommitted tree (20 subsystem reviewers, each finding adversarially verified against the code). The prior review (`unified-log-review-findings.md`) claimed fix-pass-3 closed all 40+ items; this pass verified most of those fixes are genuinely correct (see end) but found the following residual/new issues a green test suite cannot catch.

**44 confirmed** (10 P1, 24 P2, 10 P3), 6 refuted, 22 low-confidence P3 unverified.

> **Design rulings (project owner, 2026-06-16):** (1) Build refs — an explicit ref (`?ref=state:{hash}` or `ctx:{id}`) builds at that target; with no ref, build off **main HEAD**; `contextId` is runtime identity, not a build selector. Applies to panels AND workers/DOs (main-default; ctx only when explicitly pinned). (2) Specialized agents **extend** (append to) the NatStack base prompt, not replace it. Findings premised on the opposite were removed (not bugs).

---

## P1 findings

### P1-1 — Interrupted turn wedges forever if the model executor's terminal is lost to DO eviction (wake has no interrupted-turn cleanup)
- **Subsystem:** agent-loop pure package (fold / step / effects)  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agent-loop/src/step.ts:539-612`, `workspace/packages/agent-loop/src/step.ts:485-489`, `workspace/packages/agent-loop/src/step.ts:675-694`  
- **What:** When `interrupt`/`abort` arrives mid-model-call, commandStep journals only the interrupt marker and defers all cleanup to when the model's interrupted terminal lands (step.ts:485-489 returns `{append:[marker],effects:[]}`). The fold sets `openTurn.interrupted=true`. In a hibernation-first world the driver aborts the executor, but if the DO evicts before the executor appends its interrupted `message.completed` terminal, that terminal is lost. On the next `wake`: (1) the orphan in-flight call is failed with a recoverable `message.failed` (step.ts:542-553); (2) BOTH wake recovery branches — tool re-expansion (line 559) and next-model-call (line 590) — require `!afterOrphan.openTurn.interrupted`, so neither fires; (3) the pendingPrompt branch (line 598) requires no open turn; (4) the function falls through to `return {append, effects:[]}`. No `turn.closed` is ever produced and `interruptCleanupItems` is never invoked. The cascaded eventStep for the orphan `message.failed` also bails (`if (!turn || turn.interrupted) return EMPTY`, step.ts:677). The interrupted turn stays open+interrupted indefinitely; its pendingInvocations/pendingApprovals/pendingCredentialWaits are never settled.

- **Impact:** After a user interrupt that races a DO eviction, the agent turn never closes and the channel is stuck `running_model`/`waiting_external` forever. Worse, `derivePendingEffects` keeps deriving the un-settled invocations' dispatch effects, so the driver's reconcile can RE-DISPATCH the tool calls the user tried to interrupt. User-visible hang plus side-effect re-execution of interrupted work.

- **Suggested fix:** Add a wake branch: if `afterOrphan.openTurn && afterOrphan.openTurn.interrupted && !afterOrphan.inFlightModelCall`, emit `interruptCleanupItems(afterOrphan, 'user_interrupted')` (which settles pendings and appends turn.closed). Equivalently, have the orphan-failure eventStep path run cleanup when the turn is interrupted instead of returning EMPTY.

- **Verifier evidence:** step.ts:485-489 (defer): `if (state.inFlightModelCall) {\n  // The driver aborts the model executor; cleanup happens when its\n  // interrupted terminal lands (E-model-terminal interrupted path).\n  return { append: [marker], effects: [] };\n}`

fold.ts:328-331 (flag set, in-flight kept): `if (detailKind === "interrupt") {\n  return state.openTurn\n    ? { ...state, openTurn: { ...state.openTurn, interrupted: true } }\n    : state;\n}`

step.ts:542-553 (wake orphan-fails the in-flight call) followed by fold.ts:151-154 clearing inFlightModelCall.

step.ts:559 `if (afterOrphan.openTurn && !afterOrphan.openTurn.interrupted && !afterOrphan.inFlightModelCall) {` and step.ts:588-590 `afterOrphan.openTurn && !afterOrphan.openTurn.interrupted && wakeGuardSatisfied(afterOrphan) && ...` — both gated off; step.ts:598 `if (!afterOrphan.openTurn && afterOrphan.pendingPrompt)`; step.ts:611 `return { append, effects: [] };`.

step.ts:675-677 (cascade bails): `if (kind === "message.failed") {\n  const turn = state.openTurn;\n  if (!turn || turn.interrupted) return EMPTY;`

effects.ts:213-216 (re-derive, no interrupted check): `for (const invocation of Object.values(state.pendingInvocations)) {\n  if (invocation.requiresApproval && invocation.approvalState !== "granted") continue;\n  out.push(invocationEffect(state, invocation));\n}` + agent-loop-driver.ts:429-432 reconcile re-insert of any expected effect not present.

### P1-2 — Persistent head-conflict (retries exhausted) falls into the id-collision branch and re-executes the whole effect — the exact AL-5 hazard
- **Subsystem:** agentic-do driver + outbox + executors  
- **Category:** bug  
- **Prior finding:** AL-5 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/agentic-do/src/agent-loop-driver.ts:579-601`  
- **What:** In applyOutcome the append retry loop distinguishes head-conflict (reload + retry the outcome append) from id-collision (drop row, reconcile). But after HEAD_CONFLICT_RETRIES (3) the loop guard `attempt < HEAD_CONFLICT_RETRIES` becomes false, so a 4th *head-conflict* error skips the retry branch and falls through to `if (code !== null)` at line 589, which DELETES the outbox row, reloads, and reconciles. The comment there (lines 590-593) explicitly assumes 'the log already holds a terminal for this effect — a raced duplicate execution', but a head-conflict means NO terminal was written; the head merely kept moving. Deleting the row makes reconcile re-derive the still-pending effect (inFlightModelCall / pending tool) and re-execute it — a duplicate model call or a re-run of a mutating tool, plus the completed outcome (model blocks) is discarded. This is precisely the AL-5 failure the fix was meant to prevent; the fix only covers it for ≤3 conflicts.

- **Impact:** On a sustained head-mover (two briefly-coexisting hibernation isolates writing the same trajectory log, or a fork racing the driver), a completed model turn's blocks are thrown away and the model call (or a mutating tool) is re-executed. Low probability (needs 4 consecutive conflicting appends) but a real integrity/duplication hole and a mis-stated invariant.

- **Suggested fix:** On head-conflict exhaustion, do NOT fall into the delete-and-re-derive branch. Either keep retrying head-conflict with backoff (it is deterministic and our events are new), or surface it as a retryable driver error that leaves the row leased so the outcome append is re-attempted after lease expiry — never discard a completed outcome and re-run the effect. Gate the line-589 branch on `code !== 'head-conflict'`.

- **Verifier evidence:** agent-loop-driver.ts:571-601:
  for (let attempt = 0; envelopes === null; attempt += 1) {
    ...
    try { envelopes = await this.append(loop, items); }
    catch (err) {
      const code = err instanceof Error ? classifyGadAppendError(err) : null;
      if (code === "head-conflict" && attempt < HEAD_CONFLICT_RETRIES) {  // line 579
        // ...reload fold and retry...
        this.loops.delete(loop.channelId);
        loop = await this.loop(loop.channelId);
        continue;
      }
      if (code !== null) {                                                 // line 589
        // id-collision / replay-mismatch (or a head that will not settle):
        // the log already holds a terminal for this effect — a raced
        // duplicate execution. The journaled outcome wins: drop the row,
        // reload from the log, reconcile.
        this.outbox.delete(row.branchId, row.effectId);                    // line 594
        this.loops.delete(loop.channelId);
        const fresh = await this.loop(loop.channelId);
        await this.reconcile(fresh);                                       // line 597
        this.requestPump();
        return;
      }
      throw err;
    }
  }

agent-loop-driver.ts:99: const HEAD_CONFLICT_RETRIES = 3;

append-errors.ts:14-17 (head-conflict = events are NEW, retry — no terminal written):
 * - "head-conflict":  expectedHeadHash did not match the current head and
 *                     none of the batch was an already-applied replay. The
 *                     caller's fold is stale; the events are NEW — reload
 *                     and retry the append.

agent-loop-driver.ts:429-432 (reconcile re-inserts the still-pending effect after the delete):
    for (const effect of expected) {
      if (!present.has(effect.effectId)) {
        this.outbox.insert(loop.logId, effect, this.initialDeadline(effect));
      }
    }

### P1-3 — Forked (cloned) agent never re-subscribes to the new channel — orphaned after every fork
- **Subsystem:** agentic-do vessel + worker base + channel client  
- **Category:** incomplete-design  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agentic-do/src/agent-vessel.ts:1766-1794`, `workspace/packages/agentic-do/src/subscription-manager.ts:172-179`, `workspace/workers/fork/fork.ts:134-142`, `workspace/workers/pubsub-channel/channel-do.ts:1466-1482`  
- **What:** On a semantic fork, the channel DO's postClone does `DELETE FROM participants` (channel-do.ts:1477), and the fork worker calls `postClone` (not `subscribeChannel`) on each CLONED agent (fork.ts:140). The cloned agent's vessel postClone (agent-vessel.ts:1766-1794) only forks the trajectory log, wipes effect_outbox/fold_cache, calls `subscriptions.rename(old,new)` and `driver.wake(newChannelId)`. It NEVER calls `channel.subscribe`/`subscriptions.subscribe` against the new channel DO. Since `INSERT INTO participants` happens ONLY inside the channel DO's `subscribe` (channel-do.ts:597) and broadcast.ts delivers `onChannelEnvelope` exclusively to rows in the `participants` table (broadcast.ts:95-127), the cloned agent is absent from the forked channel's roster and receives no further deliveries. Only `toReplace` participants are re-subscribed (fork.ts:146). The project memory's documented postClone contract explicitly lists a 'resubscribe to forked channel' step, which is missing here.

- **Impact:** After any fork that carries an agent over (the common case — the agent being forked is a clone), the forked conversation's agent is dead: it gets no inbound messages from the new channel, does not appear in the roster, and cannot be addressed. Forking — a marquee feature — produces a non-functional agent in the forked branch.

- **Suggested fix:** In agent-vessel.ts postClone, after rename, re-establish the channel subscription against the new channel DO (call subscriptions.subscribe / channel.subscribe with the cloned descriptor and contextId) so the channel's participants table re-registers the cloned agent and its doRef before wake; or have fork.ts call subscribeChannel for cloned agents too.

- **Verifier evidence:** channel-do.ts:1476 (postClone, def at 1466): `this.sql.exec(\`DELETE FROM participants\`);` — roster wiped, rebuildAfterFork (1479) does not repopulate it.
fork.ts:140: `await callDoTarget(rpc, clonedRef, "postClone", ref.objectKey, forkedChannelId, opts.channelId, opts.forkPointPubsubId);` — clones get postClone, not subscribeChannel.
fork.ts:146: `await callDoTarget(rpc, doRef, "subscribeChannel", { channelId: forkedChannelId, contextId });` — ONLY toReplace are subscribed.
agent-vessel.ts:1791-1793 (postClone): `this.subscriptions.rename(oldChannelId, newChannelId); await this.onPostClone(); await driver.wake(newChannelId);` — no channel.subscribe.
subscription-manager.ts:173-178 (rename): `this.sql.exec(\`UPDATE subscriptions SET channel_id = ? WHERE channel_id = ?\`, newChannelId, oldChannelId);` — local-only, never contacts channel DO.
subscription-manager.ts:76 (subscribe): `const subResult = await channel.subscribe(participantId, metadata);` → channel-do.ts:597 `INSERT INTO participants (...)` — the sole roster-insert path, reached only via agent-vessel.ts:934 subscribeChannel.
agent-loop-driver.ts:212-220 (wake): operates on GAD loop/outbox only — `const loop = await this.loop(channelId); ... await this.runStep(loop, { type: "command", command: { kind: "wake" } }, APPEND_RETRIES);` — no subscribe.
broadcast.ts:95-97: `const participants = deps.sql.exec(\`SELECT id, transport FROM participants\`).toArray();` — delivery strictly from the (now-empty-of-the-clone) roster.

### P1-4 — Mode-only change on one side is silently dropped during merge (executable bit lost)
- **Subsystem:** gadVcs merge engine + diff3  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gadVcs/merge.ts:150-156`  
- **What:** `oursChanged`/`theirsChanged` are computed exclusively from `content_hash` (lines 150-151), completely ignoring `mode`. Consider base mode 0644, theirs flips the file executable (0755) with identical content, ours leaves it untouched. Both `oursChanged` and `theirsChanged` evaluate false (content_hash identical on all three), so control reaches the `!oursChanged && !theirsChanged` branch (line 153) and `keep(o)` carries OURS' mode (0644). The executable-bit change made on theirs is silently discarded with no `mode` conflict flagged. Modes are genuinely tracked and persisted: store.ts:283 records mode 33261 vs 33188 from the on-disk executable bit, and materialization chmods 0755/0644 (store.ts:476-477, 559, 589). So this is a real, persisted, user-meaningful property being lost on merge. The dedicated mode-conflict path at lines 166-169 only fires inside the `both content-changed` branch, so it never covers the common case where only the mode (not content) diverged.

- **Impact:** A merge silently reverts a legitimate chmod made in a context/branch. An executable script committed in a context loses its +x bit when merged into main if main did not also edit that file's content. No conflict is raised, so the user has no signal anything was dropped.

- **Suggested fix:** Fold mode into the change detection: compute `oursChanged`/`theirsChanged` from (content_hash, mode) pair, or add an explicit mode-only-change arm that takes the changed side's mode when only one side altered mode, and flags a `mode` conflict when both altered mode differently.

- **Verifier evidence:** src/server/gadVcs/merge.ts:150-151 — `const oursChanged = (o?.content_hash ?? null) !== (b?.content_hash ?? null); const theirsChanged = (t?.content_hash ?? null) !== (b?.content_hash ?? null);` (mode ignored). merge.ts:153-156 — `if (!oursChanged && !theirsChanged) { if (o) keep(o); continue; }`. merge.ts:142-144 — `const keep = (file: StateFile): void => { merged.push({ path: file.path, contentHash: file.content_hash, size: 0, mode: file.mode }); };` (carries OURS' mode). merge.ts:165-168 — mode-conflict handling is gated behind `// Both changed.`: `if (o && t && o.content_hash === t.content_hash) { keep(o.mode === t.mode ? o : { ...o, mode: 33188 }); if (o.mode !== t.mode) conflicts.push({ path, kind: "mode" }); }`. Persistence proof: store.ts:283 `mode: stat.mode & 0o111 ? 33261 : 33188`; store.ts:476-477 `const executable = file.mode === 33261; await fsp.chmod(absPath, executable ? 0o755 : 0o644);`.

### P1-5 — materializeState crashes on any file↔directory path-type transition (checkout primitive throws)
- **Subsystem:** gadVcs store + CAS materialization  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gadVcs/store.ts:452-486`, `src/server/gadVcs/store.ts:471`, `src/server/gadVcs/store.ts:474-475`, `src/server/gadVcs/store.ts:488-496`  
- **What:** materializeState() runs its write loop (lines 452-486) BEFORE its deletion loop (lines 488-496) over a directory that is reused across states. This breaks two common transitions:

(1) File→directory at the same path. Old state has regular file `foo`; target state has `foo/bar.ts`. In the write loop for `foo/bar.ts`, line 471 calls `fsp.mkdir(path.dirname(absPath), {recursive:true})` = mkdir of `<dir>/foo`. Because `foo` still exists as a regular file (the deletion loop that would remove it hasn't run yet), recursive mkdir throws ENOTDIR/EEXIST and materializeState rejects.

(2) Directory→file at the same path. Old state has `foo/bar.ts`; target has regular file `foo`. In the write loop for file `foo`, line 474 calls `fsp.rm(absPath, {force:true})` with no `recursive:true`. `foo` is a non-empty directory on disk, so `fs.rm` throws EISDIR/ENOTEMPTY (force does not delete directories without recursive), and copyFile never runs.

The deletion loop at 488-496 (which removes stale paths) is ordered after the write loop and also uses non-recursive `fsp.rm`, so it cannot clear the leftover directory either. materializeState is the checkout primitive used by context folders, merge resolution, the git bridge, and fork checkout (workspaceVcs.ts:282/614/739/776/814/1061/1081; gitBridge.ts:131), so any state transition that converts a file into a directory (or vice-versa) at the same path makes checkout throw.

- **Impact:** Converting a file into a directory (e.g. `config.ts` → `config/index.ts`) or a directory into a file is an extremely common refactor for both humans and coding agents. Any snapshot containing such a transition becomes un-checkout-able: materializeState throws, breaking context-folder sync, merge materialization, fork checkout, and git export. The new test suite only exercises add/edit/delete of distinct paths, so it never hits this.

- **Suggested fix:** Before the write loop, delete any on-disk path whose type conflicts with the target: run the stale-path deletion first, OR for each target file, if a path component along absPath exists as a non-directory remove it, and replace the line 474 `fsp.rm(absPath,{force:true})` with `fsp.rm(absPath,{force:true,recursive:true})` so an existing directory at a now-file path is cleared. Add tests for file→dir and dir→file transitions across two successive materializeState calls into the same dir.

- **Verifier evidence:** src/server/gadVcs/store.ts:452-486 write loop runs first; line 471: `await fsp.mkdir(path.dirname(absPath), { recursive: true });` (throws ENOTDIR when a path component is an existing file); line 474: `await fsp.rm(absPath, { force: true });` (no recursive → throws EISDIR/ENOTEMPTY on an existing directory) followed by line 475: `await fsp.copyFile(source, absPath);`. Deletion loop ordered after at lines 488-496, line 493: `await fsp.rm(path.join(dir, ...relPath.split("/")), { force: true });` (also non-recursive). Call sites confirming it is the checkout primitive: gitBridge.ts:131 `await vcs.vcs.materializeState(entry.outputStateHash, gitDir);` and workspaceVcs.ts:282/588/614/739/776/814/1061/1081.

### P1-6 — applyEdits conflicted path mis-sets lastState to the provisional (un-published) state, so the merge-resolution commit emits an understated changedPaths and the build trigger never rebuilds the theirs-incorporated files
- **Subsystem:** gadVcs WorkspaceVcs + gitBridge  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gadVcs/workspaceVcs.ts:1067`, `src/server/gadVcs/workspaceVcs.ts:1075`, `src/server/gadVcs/workspaceVcs.ts:262`, `src/server/gadVcs/workspaceVcs.ts:323-333`  
- **What:** In applyEdits' conflicted branch the code does `this.lastState.set(input.head, provisional.stateHash)` (line 1067) and returns WITHOUT emitting a `state-advanced` event (the durable head ref is still `oursStateHash`/`headState` — only a provisional was staged + parked as pending). The provisional merged tree therefore never reaches the build trigger. When the user later resolves the conflict via commit()/commitHead, `prevState = this.lastState.get(head)` (line 262) is the provisional state, so the merge-resolution event diffs provisional->resolved, which only contains the conflict-marker edits the user made. All the non-conflicting files that `theirs` brought into the merge (present in the resolved durable state but absent from `ours`) are diffed away as 'unchanged' and never appear in `changedPaths`/`fileChanges`. By contrast mergeHeads' conflicted branch (lines 759-782) deliberately does NOT touch lastState, leaving it at oursState so the resolution diffs the full ours->resolved delta. The two conflict-resolution paths are inconsistent, and the applyEdits one understates the change set.

- **Impact:** After resolving an applyEdits/revert-induced conflict, units whose sources were changed only by the incoming (theirs) side are not rebuilt — the panel/agent serves a stale build for those units until some unrelated edit happens to touch them. A green suite misses this because no test resolves an applyEdits conflict and then asserts on the emitted changedPaths/build trigger.

- **Suggested fix:** Mirror mergeHeads: in the applyEdits conflicted branch do NOT set lastState to provisional (leave it at `headState`), so the eventual resolution commit diffs headState->resolved (the full merge delta). If lastState must be advanced for the dirty-worktree fast path, store `headState` instead of `provisional.stateHash`.

- **Verifier evidence:** src/server/gadVcs/workspaceVcs.ts:1044-1075 (applyEdits conflicted branch): `const provisional = await this.gad().call<{ stateHash: string }>("stageWorktreeState", {...})` ... `await this.vcs.materializeState(provisional.stateHash, dir);` ... line 1067 `this.lastState.set(input.head, provisional.stateHash);` then line 1068 `return { head: input.head, stateHash: provisional.stateHash, eventId: null, headHash: null, status, conflicts, changedPaths: await this.diffPaths(headState, provisional.stateHash) };` — returns with no state-advanced emit; durable head ref unchanged (stageWorktreeState, not ingestWorktreeState).

src/server/gadVcs/workspaceVcs.ts:925 `const headState = (await this.vcs.resolveWorktreeRef(input.head)) ?? input.baseStateHash;` (durable ours head).

src/server/gadVcs/workspaceVcs.ts:262 `const prevState = this.lastState.get(head) ?? (await this.vcs.resolveWorktreeRef(head));` and lines 322-333: `if (!snap.unchanged) { const event = await this.stateAdvancedEvent({ head, previousStateHash: prevState, stateHash: snap.stateHash, ... transitionKind: pending ? "merge-resolution" : "snapshot" }); changedPaths = event.changedPaths; this.emitter.emit("state-advanced", event); }` — diff basis is prevState (=provisional after an applyEdits conflict), never pending.oursStateHash.

src/server/gadVcs/workspaceVcs.ts:504-516 `const fileChanges = input.previousStateHash === input.stateHash ? [] : await this.diffFileChanges(input.previousStateHash, input.stateHash); ... changedPaths: fileChanges.map((change) => change.path)`.

Contrast — mergeHeads conflicted branch src/server/gadVcs/workspaceVcs.ts:759-782 stages, parks pending, materializes, and `return { status: "conflicted", stateHash: staged.stateHash, conflicts: result.conflicts };` with NO this.lastState.set (lastState was set to oursState at line 680).

grep confirms pending.oursStateHash is consulted only in abortMerge: src/server/gadVcs/workspaceVcs.ts:814-815 `await this.vcs.materializeState(pending.oursStateHash, ...); this.lastState.set(targetHead, pending.oursStateHash);`.

### P1-7 — GitBridge.exportHead commits the internal `.gad/CHECKOUT.json` sidecar into every exported git commit
- **Subsystem:** gadVcs WorkspaceVcs + gitBridge  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gadVcs/gitBridge.ts:131`, `src/server/gadVcs/gitBridge.ts:132`, `src/server/gadVcs/store.ts:509`  
- **What:** exportHead materializes each transition with `vcs.vcs.materializeState(entry.outputStateHash, gitDir)` (line 131). materializeState always writes the `.gad/CHECKOUT.json` sidecar into its target dir (store.ts:509). It then runs `this.git.addAll(gitDir)` (line 132). GitClient.addAll only skips files git reports as `ignored` (packages/git/src/client.ts:992), and the materialized tree contains no .gitignore entry for `.gad` (the repo root .gitignore has no `.gad` rule — only `workspace/.contexts/`). So `.gad/CHECKOUT.json` is committed into every exported commit. Worse, its `stateHash` field changes on each export, producing a spurious churned file in every commit pushed to GitHub. The gitBridge.test.ts only greps commit subjects and reads a.txt/b.txt, so it never notices the polluting `.gad` entry.

- **Impact:** Every git export (the GitHub interchange path) pushes the VCS-internal cache file, polluting external repos and creating noise diffs on every transition. The sidecar is a deletable P1 cache that must never enter interchange output.

- **Suggested fix:** In exportHead, remove the `.gad` directory from gitDir before addAll (or exclude it from the commit), e.g. `await fsp.rm(path.join(gitDir, '.gad'), {recursive:true, force:true})` after materializeState and before addAll; or have materializeState accept a `noSidecar`/sidecar-path option for bridge use.

- **Verifier evidence:** gitBridge.ts:131-132:
`      await vcs.vcs.materializeState(entry.outputStateHash, gitDir);`
`      await this.git.addAll(gitDir);`

store.ts:509 (inside materializeState, store.ts:438):
`    await this.writeSidecar(dir, { version: 1, stateHash, files: entries });`

store.ts:90-91 / 232-234:
`const SIDECAR_DIR = ".gad";`
`const SIDECAR_FILE = "CHECKOUT.json";`
`  private sidecarPath(dir: string): string { return path.join(dir, SIDECAR_DIR, SIDECAR_FILE); }`

client.ts:992 (addAll only skips unmodified/ignored):
`      } else if (file.status !== "unmodified" && file.status !== "ignored") {`

.gitignore:62 (no .gad rule): `workspace/.contexts/`

Runtime test output: `git ls-files` in the export checkout listed `.gad/CHECKOUT.json` and `a.txt`; SIDECAR TRACKED: true.

### P1-8 — DO class-default runtime image poisoned by first context-scoped object → main-tracking objects load wrong-scope code
- **Subsystem:** server boot/index + workerdManager + gateway + headless-host  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/workerdManager.ts:2351-2382`, `src/server/workerdManager.ts:1169-1200 (getDoCode fallback `objectBuild?.imageId ?? svc.imageId`)`, `src/server/workerdManager.ts:570-605 (ensureDurableObjectEntity passes imageId=targetId)`  
- **What:** In ensureDOClass, when a DO class is registered for the FIRST time via an object carrying an explicit non-main scopeRef (e.g. ensureDurableObjectEntity with ref="ctx:abc", which passes opts.imageId=targetId, opts.scopeRef, opts.objectKey), the class-level doServices entry is populated with imageId=opts.imageId (the ctx-scoped OBJECT's image) and scopeRef=ctx:abc (lines 2359, 2365-2372). The class default thereby points at a context-forked build. Later, a DIFFERENT object of the same class that tracks main (ref undefined → no doObjectBuilds entry) is served by getDoVersion/getDoCode which fall back to `svc.imageId` (the ctx-scoped image). So a main-tracking DO object loads code built from context abc instead of main. There is no guard forcing the class default to the main-head build. Context forks are first-class (workerd.ts:64 documents ctx:/state: refs; runtimeService passes spec.ref straight through), and semantic fork is explicitly designed to let context code diverge from main.

- **Impact:** A durable object pinned to main can silently execute code from a forked context (or vice versa), depending purely on which object happened to register the class first after a workerd boot. Order-dependent, hard to reproduce, and corrupts the isolation guarantee context forks are supposed to provide.

- **Suggested fix:** Keep doServices.imageId bound to the main-head build (do-service:source:className) regardless of which object triggers the first ensure; only store object-specific (ctx/state) images in doObjectBuilds. When isNew && opts.scopeRef && opts.objectKey, bind BOTH the main class default image AND the object-specific image, and never let opts.imageId overwrite the class default.

- **Verifier evidence:** src/server/workerdManager.ts:2358-2372 (isNew branch poisons class default):
  const imageId = opts.imageId ?? `do-service:${serviceKey}`;
  image = await this.bindRuntimeImage(imageId, source, opts.scopeRef);
  ...
  this.doServices.set(serviceKey, { buildKey, className, ...(image ? { imageId: image.id } : {}), serviceName, source, ...(opts.scopeRef ? { scopeRef: opts.scopeRef } : {}), });

src/server/workerdManager.ts:2377-2390 (main-tracking object, scopeRef undefined, never writes a per-object build):
  } else if (!isInternalDOSource(source) && opts.scopeRef && opts.objectKey) { ... }
  if (!isInternalDOSource(source) && opts.scopeRef && opts.objectKey && image) { this.doObjectBuilds.set(...); }

src/server/workerdManager.ts:1178 (getDoCode fallback to poisoned class default):
  const imageId = objectBuild?.imageId ?? svc.imageId;

src/server/workerdManager.ts:1148-1149 (getDoVersion same fallback):
  const image = svc.imageId ? this.runtimeImages.get(svc.imageId) : null;
  return image ? String(image.generation) : svc.buildKey;

src/server/workerdManager.ts:583-590 (ensureDurableObjectEntity passes imageId=targetId, scopeRef, objectKey):
  const scopeRef = isBootstrapMainBoundDo(args.source, args.className) ? args.ref : explicitScopeRef(args.ref);
  await this.ensureDOClass(args.source, args.className, { scopeRef, objectKey: args.key, imageId: targetId });

src/server/workerdManager.ts:2630-2632 (main rebuild skips ctx-scoped class default, so poison is durable):
  const trackedServices = Array.from(this.doServices.values()).filter((s) => s.source === source && scopeTracksHead(s.scopeRef, head));

### P1-9 — Unpublished-changes count never refreshes after edits — Publish silently lies and the button can be stuck disabled
- **Subsystem:** spectrolite panel + agentic-chat UI (git->vcs migration)  
- **Category:** ux-breakage  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/panels/spectrolite/app/createApp.ts:118-123`, `workspace/panels/spectrolite/app/createApp.ts:192-200`, `workspace/panels/spectrolite/coedit/docController.ts:211-237`, `workspace/panels/spectrolite/coedit/docController.ts:239-292`, `workspace/panels/spectrolite/components/PublishBar.tsx:76-82`  
- **What:** PublishController.refresh() (which recomputes `ahead` / `files` via vcs.publishStatus) is invoked in only two places: VaultController.onVaultSelected (createApp.ts:121) and app.start() (createApp.ts:198). Nothing re-runs it on head advance. The vault lives on a durable ctx head that is advanced by every autosave commit (docController.commitNow, which calls vcs.applyEdits) and by every remote/agent commit (docController.onHeadAdvance). docController owns its OWN vcs.subscribeHead subscription for editor reconcile but never notifies `publish`. Consequently the always-visible '● N unpublished changes' indicator (PublishBar + drawers PublishSummary) goes stale immediately after the user types anything or after an agent edits the vault. Worse, the Publish button is `disabled={!hasChanges || snapshot.publishing}` (PublishBar.tsx:76) — if the panel loaded with 0 unpublished changes and the user then makes edits, snapshot.ahead stays 0, the button stays disabled, and the user CANNOT publish their work until they reselect the vault or reload the panel. This is the primary publish affordance of the whole git→vcs migration.

- **Impact:** Core publish UX is broken: the unpublished-changes indicator shows wrong counts and the Publish button is unusable for freshly-made edits until a full vault reselect/reload. Users (and agents) can lose the ability to publish what they just wrote.

- **Suggested fix:** Subscribe publish.refresh() to vault head advances. Either give PublishController its own vcs.subscribeHead(vaultHead) that calls refresh() on each advance (debounced), or have docController/app invoke publish.refresh() after commitNow() succeeds and inside onHeadAdvance(). createApp already has `vaultHead`; wire a single subscribeHead there that triggers publish.refresh().

- **Verifier evidence:** createApp.ts:118-123 — only head-related refresh on vault SELECT, not advance:
  const vault = new VaultController(store, {
    onVaultSelected: (repoRoot) => {
      session.onVaultSelected(repoRoot);
      void publish.refresh();
    },
  });
createApp.ts:196-199 — refresh only at start():
      if (store.getState().repoRoot !== null) {
        void vault.refreshPaths();
        void publish.refresh();
      }
docController.ts:226-234 — autosave commit advances head, no publish notify:
    const result = await this.deps.vcs.applyEdits({ baseStateHash: this.baseStateHash, edits: built.edits });
    this.baseStateHash = result.stateHash;
    this.baseText = canonical;
    this.lastSelfStateHash = result.stateHash;
    this.deps.editor.rebase(canonical);
    this.deps.undo?.sealCommit(result.stateHash);
docController.ts:168-170 — the only subscribeHead, reconcile-only:
    this.offHead = this.deps.vcs.subscribeHead(this.deps.vaultHead, (advance) => { void this.onHeadAdvance(advance); });
PublishBar.tsx:32-33,76 — disabled gate keyed on stale ahead:
  const count = snapshot.ahead;
  const hasChanges = count > 0;
  ...
          disabled={!hasChanges || snapshot.publishing}
publishController.ts:89-95 — ahead only ever set by refresh():
  async refresh(): Promise<void> { ... this.set({ ahead: status.ahead, files: status.files, pending, lastError: null }); ... }
DocumentEditor.tsx:144-152 — DocController constructed with no publish handle:
      const controller = new DocController({ editor: core, vcs, vaultHead: app.vaultHead, viewState: app.viewState, splitBlocks: ..., onCollisions: ..., undo });

### P1-10 — Silent agent loses its only way to speak when `allowedTools` is set without `say`
- **Subsystem:** vessel workers (gmail/silent/agent-worker/hello)  
- **Category:** bug  
- **Prior finding:** CAP-4 (prior-fix-incomplete)  
- **Locations:** `workspace/workers/silent-agent-worker/index.ts:43-49`  
- **What:** `getLoopTools` builds `[...super.getLoopTools(channelId), say]` and, when `cfg.allowedTools` is non-empty, filters with `allowed = new Set(cfg.allowedTools)` then `tools.filter(t => allowed.has(t.name))`. Unlike the deleted `createRunner` implementation (visible in the diff) which built `new Set([...allowedTools, "say"])` — it ALWAYS forced `say` into the allow-set — the new code does NOT auto-include `say`. The silentPolicy (agent-loop/src/policies/index.ts:343) suppresses publication of every trajectory item except turn.opened/turn.closed, so the `say` tool (which calls `createChannelClient().send()` directly, bypassing trajectory publication) is the silent agent's ONLY channel to communicate. A config author who sets `allowedTools` to restrict the agent (e.g. `["read","memory_recall"]`) silently strips `say`, leaving the agent permanently mute.

- **Impact:** A configured silent agent with any non-empty allowedTools can never produce a visible message — it can think and act but cannot ever speak to the channel. This is the exact CAP-4 concern, re-introduced in the opposite direction by fix pass 3.

- **Suggested fix:** Force-include `say` in the allow-set: `const allowed = new Set([...cfg.allowedTools, "say"]);` (mirroring the old createRunner behavior), and document that `say` is non-excludable for silent agents.

- **Verifier evidence:** workspace/workers/silent-agent-worker/index.ts:43-49 (current):\n```\n  protected override getLoopTools(channelId: string): AgentTool[] {\n    const cfg = asSilentAgentConfig(this.subscriptions.getConfig(channelId));\n    const tools = [...super.getLoopTools(channelId), this.createSayTool(channelId)];\n    if (!cfg.allowedTools || cfg.allowedTools.length === 0) return tools;\n    const allowed = new Set(cfg.allowedTools);\n    return tools.filter((tool) => allowed.has(tool.name));\n  }\n```\n`say` is in `tools` but not auto-added to `allowed`, so it is dropped when allowedTools omits it.\n\nDeleted createRunner (git diff HEAD), which DID force say:\n`new Set([...allowedTools.filter((tool): tool is string => typeof tool === \"string\"), \"say\"])`\n\nsilentPolicy suppresses all non-turn-boundary publication — workspace/packages/agent-loop/src/policies/index.ts:346-351:\n```\n    items.map((item) =>\n      item.payloadKind === \"turn.opened\" || item.payloadKind === \"turn.closed\"\n        ? item\n        : { ...item, publish: false }\n    );\n```\nsay bypasses publication via direct send — index.ts:82: `await this.createChannelClient(channelId).send(participantId, messageId, input.content, {`

---

## P2 findings

### P2-11 — effectFailedStep has no fail-closed exhaustiveness guard; an unmapped effect-id prefix returns EMPTY and the driver re-dispatches/fails forever (AL-7 fix incomplete)
- **Subsystem:** agent-loop pure package (fold / step / effects)  
- **Category:** incomplete-design  
- **Prior finding:** AL-7 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/agent-loop/src/step.ts:767-892`, `workspace/packages/agent-loop/src/effects.ts:210-224`  
- **What:** AL-7's fix called for an exhaustiveness guard so that EVERY effect-id prefix `derivePendingEffects` can produce maps to a fail-closed resolution+terminal, never returning empty. The current `effectFailedStep` handles `model_call` (by kind), `credential_wait` (by kind), `form:` (by effectId prefix), and a catch-all that treats anything else as an invocation keyed on `inv:`/raw effectId — but that catch-all returns EMPTY whenever `state.pendingInvocations[invocationId]` is absent (step.ts:871). There is no exhaustive `switch`/never-check tied to the `EffectKind` union or the effect-id prefix set (`model:`/`inv:`/`form:`/`credwait:`). The `form:` and invocation EMPTY returns are safe today only because the corresponding pending is gone (so the effect is no longer derived). But the design lacks the guard the fix promised: if a future effect kind/prefix is added to `derivePendingEffects` without a matching branch here, a failure of that effect returns EMPTY while the effect remains derivable → infinite dispatch/fail/reconcile loop. The claimed exhaustiveness guard is simply not present.

- **Impact:** Latent: the AL-7 class of infinite-loop bug is not structurally prevented, only avoided for today's exact prefix set. A new gated/credential/http effect prefix would silently reintroduce the wedge with a green suite.

- **Suggested fix:** Replace the trailing fall-through with an explicit dispatch over the known prefixes and add a `default: { const _exhaustive: never = ...; throw }` (or fail-closed terminal append) so an unmapped effect prefix is impossible to ship silently.

- **Verifier evidence:** step.ts:867-871 (catch-all that returns EMPTY for any non-form effect whose invocation is gone): `  // local_tool / channel_call / http_call\n  const invocationId = incoming.effectId.startsWith(\"inv:\")\n    ? incoming.effectId.slice(4)\n    : incoming.effectId;\n  if (!state.pendingInvocations[invocationId]) return EMPTY;` — no exhaustiveness/never check follows. derivePendingEffects (effects.ts:210-224) emits four prefixes (ids.ts:100 `model:`, :104 `inv:`, :108 `form:`, :112 `credwait:`); effectFailedStep matches them only via the three ad-hoc branches at step.ts:773, 817, 840 plus this catch-all. AL-7 fix spec (docs/unified-log-review-findings.md:589-591): "Add an exhaustiveness guard: every effect-id prefix that `derivePendingEffects` can produce must have an `effectFailedStep` mapping (a unit test enumerating prefixes is enough)." No such guard or enumerating test exists.

### P2-12 — failEffect deletes the outbox row before journaling effect-failed; a crash in that window resets the model_call attempt budget and re-runs the model
- **Subsystem:** agentic-do driver + outbox + executors  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agentic-do/src/agent-loop-driver.ts:788-799`  
- **What:** failEffect calls `this.outbox.delete(...)` (line 790) BEFORE `handleIncoming({type:'effect-failed', ...})` journals the terminal. This inverts the 'append outcome first, then delete the row' discipline used in applyOutcome (lines 604-606). If the isolate is evicted or handleIncoming throws (e.g. transient stale-state) between the delete and the durable effect-failed append, the failure is never journaled. On recovery, the fold still shows the effect pending (inFlightModelCall set, or pendingCredentialWait present), so reconcile re-inserts a FRESH row with attempts=0 and the effect re-dispatches with a full retry budget. For a model_call that just exhausted maxAttempts=3, this means another full model run.

- **Impact:** A crash in a narrow window after maxAttempts exhaustion re-runs a model call (or re-dispatches an expired credential wait) instead of terminating it — silently violates the maxAttempts cap and can double-bill model calls. Convergent for idempotent terminals but not for the retry-count guarantee.

- **Suggested fix:** Journal the effect-failed terminal first (like applyOutcome), then delete the row — or fold the failure path through applyOutcome's append-then-delete sequence so the attempt count / terminal is durable before the row disappears.

- **Verifier evidence:** agent-loop-driver.ts:788-799 (failEffect): `async failEffect(row: OutboxRow, error: { message: string }): Promise<void> { const loop = await this.loopForBranch(row.branchId, row.channelId); this.outbox.delete(row.branchId, row.effectId); if (!loop) return; await this.handleIncoming(loop.channelId, { type: "effect-failed", effectId: row.effectId, kind: row.kind, error, attempts: row.attempts, }); }` — delete (790) precedes the durable effect-failed journal (792).

Contrast — agent-loop-driver.ts:558 `/** Outcome protocol: append outcome events FIRST, then delete the row. */`; append at line 576 (`envelopes = await this.append(loop, items);`), delete at line 605 (`this.outbox.delete(row.branchId, row.effectId);`).

effect-outbox.ts:142-145 `insert`: `INSERT OR IGNORE INTO effect_outbox ( ... attempts, next_attempt_at, created_at ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)` — attempts hardcoded to 0.

effects.ts:212 `if (state.inFlightModelCall) out.push(modelCallEffect(state, state.inFlightModelCall));` — effect re-derived while the fold still shows it pending.

agent-loop-driver.ts:430-431 (reconcile): `if (!present.has(effect.effectId)) { this.outbox.insert(loop.logId, effect, this.initialDeadline(effect)); }` — re-inserts the missing row with attempts=0.

effect-outbox.ts:86-87: `case "model_call": return 3;` — the cap that the reset bypasses.

### P2-13 — Model can never authenticate when neither the request nor the pi-ai registry carries a base URL — turn suspends on credential forever
- **Subsystem:** agentic-do driver + outbox + executors  
- **Category:** incomplete-design  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agentic-do/src/effect-executors/model-call.ts:353-390`, `workspace/packages/agentic-do/src/agent-vessel.ts:445-451`  
- **What:** getApiKey is keyed entirely on modelBaseUrl: model-call computes `modelBaseUrl = request.modelBaseUrl ?? registryModel?.baseUrl` (lines 356-358) and the vessel's getApiKey throws CredentialPendingError immediately when `!modelBaseUrl` (vessel line 451). For any provider/model whose pi-ai registry entry lacks a `baseUrl` AND whose request descriptor omits modelBaseUrl, the credential lookup can never resolve a URL, so every call returns model-suspended → publishes a connect card → the user connects → resolution re-derives the same model call → suspends again. There is no fallback to a provider-keyed (non-URL-bound) credential.

- **Impact:** A whole class of models (registry entries without baseUrl) becomes unusable: the turn wedges in a connect-card loop the user cannot escape. Whether this bites depends on the pi-ai registry contents, but the URL-only contract has no escape hatch.

- **Suggested fix:** Either guarantee request.modelBaseUrl is always populated upstream (validate at descriptor build time and fail loudly), or fall back to a provider-id-keyed credential lookup when no base URL is resolvable, so the URL-bound proxy is an optimization rather than a hard gate.

- **Verifier evidence:** model-call.ts:356-358: `const modelBaseUrl = request.modelBaseUrl ?? (typeof registryModel?.baseUrl === \"string\" ? registryModel.baseUrl : undefined);` and :376 `...(modelBaseUrl ? { modelBaseUrl } : {})`. agent-vessel.ts:451: `if (!modelBaseUrl) throw new CredentialPendingError(providerId, modelBaseUrl);`. step.ts:60-73 builds ModelRequestDescriptor with no `modelBaseUrl` field. pi-ai registry node_modules/@earendil-works/pi-ai/dist/models.generated.js:1975 `baseUrl: \"\",` (42 such entries, all under provider block `\"azure-openai-responses\"`). providerConnect.ts:72-126 PROVIDER_CONNECT_PRESETS has no azure key. model-settings/index.ts:73-85 pushes every model into the catalog. ModelPicker.tsx:75-88 renders all catalog models as clickable buttons with only a \"· no credential\" label, no disable.

### P2-14 — subscriptions.rename leaves stale participant_id (parent's objectKey) after fork
- **Subsystem:** agentic-do vessel + worker base + channel client  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agentic-do/src/subscription-manager.ts:172-179`, `workspace/packages/agentic-do/src/agent-vessel.ts:1773-1791`, `workspace/packages/agentic-do/src/agent-vessel.ts:322-332`  
- **What:** `rename()` only updates the `channel_id` column; it does not refresh `participant_id`, which encodes the DO objectKey as `do:<source>:<class>:<objectKey>`. cloneDO copies the parent's row, so after fork the stored participant_id still embeds the PARENT's objectKey. Meanwhile `participantId()` (agent-vessel.ts:322) recomputes from identity.ref (corrected to the new objectKey during ensureIdentity bootstrap). The two now diverge: `getParticipantId(channelId)` returns the parent pid while `participantId()` returns the clone pid. CardManager.getParticipantId, publishCredentialConnectCard, and publishPromptArtifactDiagnostic all source the (stale) `getParticipantId`, so post-fork cards/diagnostics are published under a participant id the new channel never knew.

- **Impact:** Post-fork custom-card publication and credential/diagnostic emits use a stale participant id, compounding the orphaning in the prior finding; card-state recovery and addressing keyed on the agent's identity are inconsistent across the fork boundary.

- **Suggested fix:** In rename (or postClone) recompute and overwrite participant_id from the corrected identity (buildParticipantId), or simply re-run subscribe which sets participant_id fresh.

- **Verifier evidence:** subscription-manager.ts:172-179: `rename(oldChannelId: string, newChannelId: string): void { this.sql.exec(\`UPDATE subscriptions SET channel_id = ? WHERE channel_id = ?\`, newChannelId, oldChannelId); }` — participant_id untouched.
subscription-manager.ts:36-39 + :86: participant_id is built as `do:${ref.source}:${ref.className}:${ref.objectKey}` and stored on subscribe.
agent-vessel.ts:1791 (postClone): `this.subscriptions.rename(oldChannelId, newChannelId);` is the only subscriptions mutation; agent-vessel.ts:281 `protected async onPostClone(): Promise<void> {}` is empty.
agent-vessel.ts:322-326 (participantId): recomputes from `this.identity.ref` (new objectKey after ensureIdentity bootstrap at :311 with this.objectKey).
Consumers of stale value: agent-vessel.ts:781 `const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();`; agent-vessel.ts:1723 same; custom-cards.ts:248 `const participantId = this.deps.getParticipantId(channelId);`.
fork.ts:137-140 clone+postClone (rename path) vs fork.ts:146 subscribeChannel (fresh-subscribe path) confirms only clones are affected.

### P2-15 — shouldRespond never passes replyToSenderId — reply-based addressing is silently dead
- **Subsystem:** agentic-do vessel + worker base + channel client  
- **Category:** expectation-violation  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agentic-do/src/agent-vessel.ts:1158-1174`, `workspace/packages/agentic-protocol/src/addressing.ts:52-54`, `workspace/packages/agentic-protocol/src/addressing.ts:97-98`  
- **What:** `explicitlyAddressed` treats a message as addressed-by-reply only when `event.replyTo && event.replyToSenderId === self.participantId` (addressing.ts:97-98). The vessel's shouldRespond builds the event with `mentions`, `replyTo`, `to`, `agentHops` but never sets `replyToSenderId` (agent-vessel.ts:1159-1166). Because `replyToSenderId` is therefore always undefined, the reply branch can never match, so a participant who replies to THIS agent's message (without an @mention or explicit `to`) is not recognized as addressing it.

- **Impact:** Under mentioned / mentioned-strict / directed policies, follow-up replies that target the agent purely via replyTo are dropped, so the agent silently fails to answer messages a user legitimately directed at it by reply. 'Why didn't it respond' becomes hard to diagnose.

- **Suggested fix:** Populate replyToSenderId in the shouldRespond event from the channel event (the sender of the message identified by replyTo), or drop the unused replyTo field if reply addressing is intentionally out of scope.

- **Verifier evidence:** addressing.ts:98 — `if (event.replyTo && event.replyToSenderId === self.participantId) return true;` (reply branch gated on replyToSenderId). agent-vessel.ts:1159-1166 — the event passed to resolveShouldRespond: `event: { senderParticipantId: event.senderId, senderKind: agentic.actor?.kind ?? "user", mentions: payload.mentions, replyTo: payload.replyTo, to: payload.to, agentHops: event.annotations?.["agentHops"] as number | undefined }` — replyToSenderId is absent. grep across workspace/src/packages shows replyToSenderId appears ONLY at addressing.ts:54 (type), addressing.ts:98 (check), and addressing.test.ts:70 (test fixture) — never set by any caller. addressing.test.ts:68-70 confirms intended behavior: `it("responds when replying to self's message", () => { ... input({ event: { replyTo: "msg-1", replyToSenderId: "agent-a" } }) ... })`.

### P2-16 — Approval-form fail-closed on a missing/erroring confirm target silently auto-denies with no user-visible diagnostic
- **Subsystem:** agentic-do vessel + worker base + channel client  
- **Category:** ux-breakage  
- **Prior finding:** CAP-1 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/agentic-do/src/agent-vessel.ts:1074-1097`, `workspace/packages/agent-loop/src/effects.ts:166-188`, `workspace/packages/agent-loop/src/policies/index.ts:111-152`  
- **What:** approvalFormEffect targets the roster's panel/user participant with method `confirm`, falling back to `{kind:'user',id:'user'}` when no panel is present (effects.ts:170-173). If the confirm channel_call resolves as a terminal that is NOT invocation.completed (panel absent, no `confirm` method registered, transport error), routeInvocationTerminal sets isError=true and maps it to `granted=false` (agent-vessel.ts:1074-1088) — a silent auto-deny. CAP-1 required fail-closed to surface a VISIBLE diagnostic. The denied tool does produce an invocation.failed the model sees, but there is no human-facing diagnostic explaining that an approval prompt could not be delivered (vs. the user actively denying), and the `id:'user'` fallback target is not a real roster pid.

- **Impact:** In a channel with no approval-capable panel (e.g. headless/agent-only contexts at approvalLevel 0/1), every gated tool is silently denied and the user sees nothing indicating the approval surface was unreachable — indistinguishable from a real denial.

- **Suggested fix:** When the approval-form terminal is an error/abandoned (not an actual granted/denied response), emit a user-visible diagnostic block (like publishPromptArtifactDiagnostic) before settling granted=false, and/or detect an unresolvable target before dispatch.

- **Verifier evidence:** effects.ts:170-173 (target fallback): `const target = state.config.roster?.participants?.find((participant) => participant.type === "panel" || participant.ref.kind === "user")?.ref ?? ({ kind: "user", id: "user" } as ParticipantRef);`

agent-vessel.ts:1074-1088 (silent deny): `const isError = kind !== "invocation.completed";` ... `if (descriptor.purpose === "approval-form") { const raw = await this.hydrateTransportValue(payload["result"]); const granted = !isError && !!raw && typeof raw === "object" && (raw as { granted?: unknown }).granted === true; outcome = { kind: "approval", granted, resolvedBy: descriptor.target, ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] as string } : {}) };`

calls.ts:328-334 (unreachable target → isError terminal): `const transport = this.deps.participantTransport(pendingRow.targetId); if (transport === null) { await this.settleCall(pendingRow.transportCallId, { error: `Target ${pendingRow.targetId} not found` }, true); return; }`

effects.ts:372-392 (emits approval.resolved {granted:false} with no delivery-failure marker) and fold.ts:248-267 (resolves with granted=payload["granted"]===true, no diagnostic branch).

Counter-evidence that narrows scope: useAgenticChat.ts:714 now registers `confirm: { ... execute: ... fb.addFeedback({ type:"schema", title: question, fields:[... buttonGroup Deny/Allow ...] ... finish(values["approval"]==="allow") }) }`, so an approval-capable panel CAN render and resolve the prompt — the universal auto-deny of original CAP-1 is fixed; only the no-panel / transport-error diagnostic remains absent.

### P2-17 — Channel reducer can resurrect a waiting turn to "open" on any trailing turn-scoped event
- **Subsystem:** agentic-protocol (envelopes, hash, stored-values, reducers)  
- **Category:** ux-breakage  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/agentic-protocol/src/reducer-channel.ts:431-446`  
- **What:** The post-switch "open-bump" block was widened. Old code only re-touched a turn that was ALREADY `status === "open"` (`if (existing?.status === "open" ...)`). New code bumps when `existing.status !== "closed"` AND now *forces* `status: "open"` (added `status: "open"` in the spread). Combined with the new `turn.waiting` status (set in the main branch when an agent parks on a credential/usage-limit wait), any later event carrying the same top-level `event.turnId` (e.g. a late `invocation.completed`/`invocation.output` delivered out of order on the unordered channel signal/live path) will flip the turn from "waiting" back to "open". turn.closed and turn.waiting are excluded, but ordinary invocation/message events that set top-level `turnId` are not.

- **Impact:** A turn the agent has parked (awaiting credential connect or usage-limit reset) can be shown in the UI as actively working again, because the chat typing/turn indicator derives from turn status. Misleads the user into thinking the agent is busy when it is actually blocked waiting for them.

- **Suggested fix:** Only force "open" when the existing status is already "open" (preserve the prior guard), or explicitly exclude `existing.status === "waiting"` from the bottom bump so a parked turn is never resurrected by a trailing non-lifecycle event.

- **Verifier evidence:** reducer-channel.ts:431-445 (current code):
```
431  if (event.turnId && event.kind !== "turn.closed" && event.kind !== "turn.waiting") {
432    const existing = next.turns[event.turnId];
433    if (existing && existing.status !== "closed" && existing.updatedAt !== event.createdAt) {
434      next = {
435        ...next,
436        turns: {
437          ...next.turns,
438          [event.turnId]: {
439            ...existing,
440            status: "open",          // <-- forces open; was absent before
441            updatedAt: event.createdAt,
442          },
443        },
444      };
445    }
```
Old code (from `git diff HEAD`): `if (existing?.status === "open" && existing.updatedAt !== event.createdAt)` with NO `status:` in the spread.

Waiting status set in main branch — reducer-channel.ts:381-386:
```
381  status:
382    event.kind === "turn.closed" ? "closed"
383      : event.kind === "turn.waiting" ? "waiting"
384      : "open",
```
ProjectedTurn type — handlers.ts:105: `status: "open" | "waiting" | "closed";`

Top-level turnId hoist for all agentic events — workspace/workers/gad-store/index.ts:1818: `...(causality?.turnId ? { turnId: causality.turnId } : {})` and index.ts:661-665: `const turnId = envelope.causality?.turnId; ... ...(turnId ? { turnId } : {})`.

Non-lifecycle events carry causality.turnId — agent-loop/src/step.ts:288-293 (invocation.started `causality: { ... turnId }`), step.ts:78 (model message `causality: { messageId, turnId }`), agent-loop/src/effects.ts:412 (invocation.completed `causality: { turnId: descriptor.turnId }`).

Lifecycle branch has seq guard the bump lacks — reducer-channel.ts:364-369: `// Seq-monotonic turn lifecycle: ignore a stale/out-of-order status event ... const staleTurnEvent = existingTurn?.lastSeq !== undefined && parsed.seq < existingTurn.lastSeq;`

### P2-18 — User approval for a main-head advance is awaited while holding the main-head serialization lock, stalling all other main operations
- **Subsystem:** approvals overhaul (bootstrap + main-advance) [NEW area]  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gadVcs/workspaceVcs.ts:259`, `src/server/gadVcs/workspaceVcs.ts:289-308`, `src/server/gadVcs/workspaceVcs.ts:640-722`, `src/server/services/vcsService.ts:99-113`, `src/server/services/mainAdvanceApproval.ts:94-167`  
- **What:** `commitHead`/`mergeHeads` run inside `this.locked(head, ...)` (serializeByKey). The `beforeAdvance` hook is invoked as `beforeIngest` INSIDE that locked region (workspaceVcs.ts:295-305 and 664-674/707-721). For main advances, `beforeAdvance` -> `mainAdvanceGate.approve` -> `approvalQueue.request`, which blocks until the human responds to the consent bar / push notification (potentially minutes, or indefinitely if the notification is never answered and the panel did not pass an AbortSignal). While that promise is pending, the `main` head lock is held, so every other operation that serializes on `head="main"` queues behind it: other commits/publishes/merges to main, and crucially the scan-on-demand `commitHead(VCS_MAIN_HEAD)` freshness path (workspaceVcs.ts:217, 343, 384). This is the same availability/boot-stall class the prior review flagged for builds (IN-6), now reintroduced through the approval gate.

- **Impact:** A single outstanding main-advance approval freezes all main-head writes and any freshness scan that needs the main lock until the user answers (or never, if the prompt is dismissed elsewhere). In hibernation-first/eviction scenarios the waiter can also outlive the requesting caller, holding the lock with no one able to resolve it from that surface.

- **Suggested fix:** Do not hold the head lock across the human wait. Compute the candidate state and changedPaths under the lock, then release the lock, run the approval, and re-acquire to ingest (re-validating the head hasn't moved). Alternatively run `beforeAdvance` before entering `locked()` using a precomputed candidate, or bound the wait with a timeout/AbortSignal so a stale prompt cannot pin main indefinitely.

- **Verifier evidence:** workspaceVcs.ts:259 `return this.locked(head, async () => {` opens the locked region; workspaceVcs.ts:293-305 inside it: `...(opts.beforeAdvance ? { beforeIngest: async (candidate) => { const event = await this.stateAdvancedEvent({...}); await opts.beforeAdvance?.(event); } } : {})`. keyedSerializer.ts:13-22 `const previous = chains.get(key) ?? Promise.resolve(); const run = previous.catch(()=>undefined).then(task); ... chains.set(key, stored); stored.finally(() => { if (chains.get(key) === stored) chains.delete(key); })` — lock held until task settles. vcsService.ts:104-112 `return async (event) => { if (event.head !== VCS_MAIN_HEAD) return; await deps.mainAdvanceGate?.approve({...event, caller: ctx.caller}); }`. mainAdvanceApproval.ts:142 `const decision = await deps.approvalQueue.request({...})` and 178 `const authorization = await requestCapabilityPermission({...}, {caller: candidate.caller, ... /* no signal */})`. workspaceVcs.ts:384 `const result = await this.commitHead(VCS_MAIN_HEAD, { summary: "workspace scan", actor: SYSTEM_ACTOR })` — freshness scan on the same \"main\" lock key (store.ts:30 `export const VCS_MAIN_HEAD = "main"`). mergeHeads repeats the in-lock beforeAdvance at workspaceVcs.ts:707-721.

### P2-20 — scheduleNextAlarm never clears a stale alarm — Theme-5 "no future deadline ⇒ no alarm" invariant violated
- **Subsystem:** pubsub channel DO rewrite + channel-policies  
- **Category:** expectation-violation  
- **Prior finding:** none (prior-fix-incomplete)  
- **Locations:** `workspace/workers/pubsub-channel/channel-do.ts:1331-1344`, `workspace/workers/pubsub-channel/channel-do.ts:730-740`  
- **What:** scheduleNextAlarm() computes the earliest future deadline from four sources and, when ALL sources are empty (`sources.length === 0`), simply `return`s. It NEVER calls `deleteAlarm()`. The base class exposes `deleteAlarm()` (durable-base.ts:833) precisely for this, but it is never invoked from the channel. Consequently, when the last deadline source disappears OUTSIDE of an alarm() run, a previously-armed alarm stays armed. Concretely: an RPC participant subscribes (arms the participant-stale alarm via scheduleNextAlarm at line 637), then `unsubscribeParticipant` (line 730) deletes it but does NOT call scheduleNextAlarm — the participant-sweep alarm remains scheduled for MIN(connected_at)+5min even though there are now zero rpc participants, no pending calls and no dedup keys. The DO wakes spuriously instead of staying hibernated.

- **Impact:** Spurious DO wake-ups defeat the hibernation-first goal that this rewrite is built around. The Theme-5/CH-4 invariant (a DO with no future deadline has NO alarm) is explicitly stated in the design and is the stated reason for the deadline-derived alarm work, but the cleanup half (clear the alarm when no deadline remains) is missing. It is self-correcting after one extra wake (the next alarm() reschedules nothing), so it is bounded, not unbounded — hence P2 not P1.

- **Suggested fix:** In scheduleNextAlarm(), when `sources.length === 0`, call `this.deleteAlarm()` instead of returning. Also call scheduleNextAlarm() (or deleteAlarm) at the end of unsubscribeParticipant/evictStaleParticipants so a departing participant retires its own stale deadline immediately.

- **Verifier evidence:** channel-do.ts:1331-1343 scheduleNextAlarm: `const sources = [ this.nextDedupSweepAt(), this.nextParticipantSweepAt(now), this.calls.nextCallDeadlineAt(), this.nextPendingRedeliveryAt(now), ].filter((value): value is number => typeof value === "number"); if (sources.length === 0) return; this.setAlarm(Math.max(Math.min(...sources) - now, 100));` — no deleteAlarm() on the empty branch.

channel-do.ts:730-740 unsubscribeParticipant: `this.sql.exec(\`DELETE FROM participants WHERE id = ?\`, participantId); cleanupDeliveryChain(this.objectKey, participantId); await this.calls.failPendingCallsTargeting(participantId, leaveReason); await this.publishPresenceEvent(participantId, "leave", metadata, leaveReason);` — returns with no reschedule.

durable-base.ts:833-837: `protected deleteAlarm(): void { void this.alarmRpc("workspace-state.alarmClear", () => this.workspaceStateService.alarmClear(this.lifecycleKey())); }` — exists, never called from channel-do.ts (grep confirms zero references).

channel-do.ts:1323-1328 nextParticipantSweepAt: `SELECT MIN(connected_at) ... WHERE transport = 'rpc'` → returns null only when no rpc rows remain; on the last unsubscribe nobody recomputes it.

docs/unified-log-review-findings.md:264-265: "A DO with no future deadline has **no** alarm. Fixed-interval polling alarms are forbidden."

### P2-21 — redeliverPendingCallsTo emits a signal that DO-transport targets cannot consume
- **Subsystem:** pubsub channel DO rewrite + channel-policies  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/workers/pubsub-channel/calls.ts:614-642`, `workspace/workers/pubsub-channel/channel-do.ts:634`  
- **What:** subscribe() calls `this.calls.redeliverPendingCallsTo(participantId)` whenever a re-subscribe replaces a session (line 634), with no filter on transport. redeliverPendingCallsTo (calls.ts:614) re-emits every in-flight call to the participant ONLY via `emitSignal` → `rpc.emit(participantId, "channel:message", channelEventToRpcSignal(...))`. DO agents (agent-vessel) receive channel traffic exclusively through `onChannelEnvelope` and method calls through `onMethodCall` (agent-vessel.ts:967, 1313); they have no handler for `channel:message` emits. So a DO target that re-subscribes with a replaced session receives a signal it silently drops — the pending call is NOT actually redelivered to it. Note the alarm-driven sibling path `redeliverStalePendingCalls` (channel-do.ts:1414) DOES filter `transport='rpc'`, showing the author knew DO targets need different handling, but the subscribe() path was left unfiltered and unconverted.

- **Impact:** A method call targeting a DO agent that is replaced/re-subscribed mid-flight is not re-dispatched to the new session; it sits pending until its deadline (or 5-min default) and then fails. User-visible as an agent that silently never answers a method call after a fork/session-replacement. Mitigated by the fact that the original DO delivery is a direct RPC whose failure settles the call immediately, so the pending-redelivery-to-DO scenario is narrow.

- **Suggested fix:** In subscribe(), gate the redeliverPendingCallsTo call to `transport !== 'do'`, or have redeliverPendingCallsTo dispatch to DO targets through deliverDoMethodCall (an actual onMethodCall RPC) rather than emitSignal.

- **Verifier evidence:** channel-do.ts:634 — `if (sessionReplaced) this.calls.redeliverPendingCallsTo(participantId);` (no transport/doRef filter).

calls.ts:614-639 — `redeliverPendingCallsTo(participantId: string): void { const rows = this.pendingFor(participantId); ... this.deps.emitSignal(participantId, event); }` (emitSignal is the sole delivery).

channel-do.ts:212-217 — `emitSignal: (participantId, event) => { void queueEmit(this.broadcastDeps, participantId, { channelId: this.objectKey, message: channelEventToRpcSignal(event) }); }`; broadcast.ts:51 — `deps.rpc.emit(subscriberId, "channel:message", payload)`.

calls.ts:337-347 + 361 — live DO dispatch uses `this.deliverDoMethodCall(...)` → `await this.deps.rpcCall(input.targetPid, "onMethodCall", [...])`, settled at calls.ts:369. agent-vessel.ts:1313 `async onMethodCall(...)` is the only method-execution entry; agent-vessel.ts:982-991 routes signal envelopes to advisory `onChannelEvent` only.

Asymmetry proof — channel-do.ts:1424 `SELECT 1 FROM participants WHERE id = ? AND transport = 'rpc'` gates redeliverStalePendingCalls; broadcast.ts:127-135 pairs the emit with `queueDoEnvelope` (onChannelEnvelope RPC) for DO participants.

### P2-22 — Concurrent settle of the same call surfaces a hard append-collision error to the RPC caller
- **Subsystem:** pubsub channel DO rewrite + channel-policies  
- **Category:** bug  
- **Prior finding:** CH-2 (prior-fix-incomplete)  
- **Locations:** `workspace/workers/pubsub-channel/calls.ts:426-452`, `workspace/workers/pubsub-channel/channel-do.ts:1204-1212`  
- **What:** settleCall reads `getEventByEnvelopeId('terminal:{id}')` and only appends the terminal if absent; the terminal append (calls.ts:445) passes NO idempotency, so the store defaults to "exact" — divergent duplicate envelopeIds are hard integrity errors (log-store.ts:39-43). Two settle flows for the same call can interleave across their awaits (e.g. the deadline alarm's timeoutExpiredPendingCalls→cancelMethodCall racing a real submitMethodResult, or two failPendingCallsTargeting/submit paths). Both can observe "no terminal yet" before either appends, then both append `terminal:{id}`: the loser gets a collision throw. failPendingCallsTargeting wraps settleCall in try/catch (calls.ts:597-604), but submitMethodResult (channel-do.ts:1204) and the alarm's timeoutExpiredPendingCalls do NOT — the error propagates out to the RPC caller / out of the alarm handler.

- **Impact:** A racing terminal yields a thrown RPC error to a legitimate submitter (panel/agent sees its submitMethodResult reject) or an unhandled rejection in the alarm. The durable terminal is still consistent (first writer wins), so it is an error-surfacing / robustness bug rather than data corruption.

- **Suggested fix:** Treat a terminal-envelope collision as success: catch the collision in settleCall, re-read `terminal:{id}`, and return its id (the row-delete + broadcast then proceed idempotently). Alternatively append the terminal with an idempotent-by-id intent so concurrent identical settles dedupe instead of colliding.

- **Verifier evidence:** calls.ts:445-451 (no idempotency passed):
```
      event = await this.deps.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload,
        senderId: opts?.senderId ?? pending.callerId,
        messageId: terminalEnvelopeId,
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      });
```
calls.ts:427-444 (read-then-append-if-absent; createdAt minted per flow):
```
    let event = await this.deps.log.getEventByEnvelopeId(terminalEnvelopeId);
    if (!event) {
      const payload = opts?.eventOverride ?? this.deps.builders().terminal({ ... createdAt: new Date().toISOString(), });
```
gad-store/index.ts:1588-1600 (divergent duplicate => hard throw when no idempotent-by-id):
```
      if (stableJson(incomingSemantic) !== stableJson(storedSemantic)) {
        if (input.idempotency === "idempotent-by-id") { replayed.push(stored); continue; }
        throw new Error(gadAppendErrorMessage("id-collision", `log envelope id collision with different content: ${event.envelopeId}`));
      }
```
log-envelope.ts:52-62 — semantic slice includes `payload` (which contains createdAt).
channel-do.ts:1204-1212 — submitMethodResult calls settleCall with NO try/catch.
channel-do.ts:1371-1378 — alarm's timeoutExpiredPendingCalls(... cancelMethodCall -> settleCall) NOT wrapped; throw escapes alarm() before scheduleNextAlarm() at 1409.
calls.ts:597-604 — only failPendingCallsTargeting guards settleCall in try/catch.

### P2-23 — panelViewport test suite still opens deleted about/dirty-repo and about/git-init panels
- **Subsystem:** cross-cutting: dangling references to deleted modules  
- **Category:** bug  
- **Prior finding:** CL-9 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/testkit/src/suites/panelViewport.ts:25-26`, `workspace/packages/testkit/src/suites/index.ts:11-13`  
- **What:** SHIPPED_PANELS in the in-system panel-viewport suite still includes `{ source: "about/dirty-repo", stateArgs: { repoPath: "panels/chat" } }` and `{ source: "about/git-init", stateArgs: { repoPath: "panels/chat" } }`. Both `workspace/about/dirty-repo/` and `workspace/about/git-init/` were DELETED in this changeset (git status shows `D workspace/about/dirty-repo/index.tsx`, `D workspace/about/git-init/index.tsx`, plus their package.json/views). The suite loops over SHIPPED_PANELS and calls `withPanel(source, ...)` for each. This suite is registered in `allSuites()` (suites/index.ts) and is consumed by the testbench panel (workspace/panels/testbench/index.tsx) and the system-testing skill (workspace/skills/system-testing/deterministic.ts). So this is live, not dead test scaffolding.

- **Impact:** When the panel-viewport suite runs (testbench / system-testing), the two tests for `about/dirty-repo` and `about/git-init` will attempt to build+open panel sources that no longer exist, producing a build/resolve failure rather than a fit-assertion. This directly contradicts the CL-9/CL-10 fix claim that the deleted panels left NO dangling references. A green vitest run does not catch this because these are in-system CDP-driven panel tests, not unit tests.

- **Suggested fix:** Remove the two `about/dirty-repo` and `about/git-init` entries from SHIPPED_PANELS in workspace/packages/testkit/src/suites/panelViewport.ts. If a VCS-status panel still ships, replace with the current source path; otherwise just delete the entries.

- **Verifier evidence:** workspace/packages/testkit/src/suites/panelViewport.ts:25-26:
  25  { source: "about/dirty-repo", stateArgs: { repoPath: "panels/chat" } },
  26  { source: "about/git-init", stateArgs: { repoPath: "panels/chat" } },

These sit inside SHIPPED_PANELS (line 18) which is looped at panelViewport.ts:31-33:
  for (const { source, stateArgs } of SHIPPED_PANELS) {
    panelViewport.test(`${source} fits a phone-sized viewport`, async (t) =>
      withPanel(source, async (handle) => { ... }, { stateArgs })

withPanel resolves the source by opening it — panels.ts:130: `const handle = await openPanel(source, opts);`

Deleted sources (git status --short):
  D workspace/about/dirty-repo/index.tsx (and package.json, DirtyRepoView.tsx)
  D workspace/about/git-init/index.tsx (and package.json, GitInitView.tsx)
`ls` on both dirs: "No such file or directory".

Suite registered + consumed: suites/index.ts:12 returns [..., panelViewport, ...]; panels/testbench/index.tsx:322 `await runSuites(allSuites(), { filter })`; skills/system-testing/deterministic.ts:14 `import { allSuites } from "@workspace/testkit/suites"`.

### P2-24 — Channel replay/poll windows read the ENTIRE channel log into memory and window in JS, bypassing the PF-1 SQL LIMIT fix
- **Subsystem:** gad-store DO (unified log core, schema v16)  
- **Category:** bug  
- **Prior finding:** PF-1 (prior-fix-incomplete)  
- **Locations:** `workspace/workers/gad-store/index.ts:4718-4758 (getChannelReplayWindow)`, `workspace/workers/gad-store/index.ts:4727 (readLog({limit:0}))`, `workspace/workers/gad-store/index.ts:4760-4771 (listChannelEnvelopesAfter)`, `workspace/workers/pubsub-channel/log-store.ts:217-227 (replayAfter)`  
- **What:** PF-1 was fixed in the core readLog() by pushing LIMIT into SQL per lineage segment. But every channel replay/catch-up path goes through getChannelReplayWindow, which calls this.readLog({logId, head:'main', limit:0}). limit:0 maps to `limit != null && limit > 0` == false, so readLog emits NO LIMIT clause and .toArray()s the whole channel (across the full fork lineage), then filters `seq > sinceSeq` / `slice(-limit)` in JS. totalCount and firstEnvelopeSeq are also computed from the full materialization, so even a bounded `after`/`before` window must decode the entire log. pubsub-channel's replayAfter (reconnect/catch-up) and replayInitial hit this on every connect; the gad-store doc and log-store.ts:6 comment claim 'server-side windowing over log_events', which is false.

- **Impact:** On a busy channel (thousands of envelopes) every reconnect, every initial window, and every inspect re-materializes and JSON-decodes the whole log. Repeated catch-up polling is O(N) per call → O(N^2) over a session — the exact PF-1 class of regression, just relocated from readLog into the channel adapter. Memory and CPU spike on the gad-store DO at precisely the cold-wake / reconnect moments.

- **Suggested fix:** Have getChannelReplayWindow push bounded SQL: for 'after' use readLog({afterSeq:sinceSeq, limit}); for 'before'/'initial' add a descending-seq SQL path (ORDER BY seq DESC LIMIT n) or a tail-window helper, and compute totalCount/firstEnvelopeSeq with COUNT(*)/MIN(seq) queries instead of materializing all rows.

- **Verifier evidence:** workspace/workers/gad-store/index.ts:4727 `const all = this.readLog({ logId: input.channelId, head: CHANNEL_LOG_HEAD, limit: 0 });` — limit:0 bypasses the SQL LIMIT.
index.ts:1466 `const remaining = limit != null && limit > 0 ? limit - collected.length : null;` and 1484-1485 `\`SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC${ remaining != null ? " LIMIT ?" : "" }\`` — confirms limit:0 → null remaining → no LIMIT, whole segment .toArray()'d (1482-1489).
index.ts:4731 `rows = all.filter((envelope) => envelope.seq > sinceSeq).slice(0, limit);` / 4736 `rows = limit > 0 ? filtered.slice(-limit) : [];` / 4738 `rows = limit > 0 ? all.slice(-limit) : [];` — JS windowing over full materialization.
index.ts:4752-4753 `totalCount: all.length, firstEnvelopeSeq: all.length > 0 ? all[0]!.seq : undefined,` — counts/min from full array.
workspace/workers/pubsub-channel/log-store.ts:218-225 replayAfter calls getChannelReplayWindow on every reconnect; 246-254 replayInitial likewise.
log-store.ts:6 comment claims "server-side windowing over log_events" — false; readLog({limit:0}) materializes the entire lineage.
PF-1 spec: docs/unified-log-review-findings.md:972-980.

### P2-25 — diff3-clean and mode/binary/delete-vs-change conflicts share no worktree markers, so non-content conflicts are invisible in the tree
- **Subsystem:** gadVcs merge engine + diff3  
- **Category:** ux-breakage  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gadVcs/merge.ts:166-188`, `src/server/gadVcs/workspaceVcs.ts:759-782`  
- **What:** A conflicted merge materializes the provisional state into the worktree for resolution. Only the `content` conflict kind embeds `<<<<<<<`/`=======`/`>>>>>>>` markers (via diff3). For `delete-vs-change` (line 174-176), `binary` (line 184-188), and `mode` (line 166-169) conflicts, the provisional state contains a clean-looking file with NO markers — delete-vs-change keeps the surviving side's content verbatim, binary keeps ours verbatim, mode keeps content with mode forced to 33188. The merge is still recorded `conflicted` and parks a pending merge requiring a resolving commit. The user opening the worktree sees normal files for these paths with nothing to indicate a conflict was auto-resolved against their intent (e.g. a file they deleted reappears, or a binary silently took 'ours').

- **Impact:** User resolves the marker-bearing files, commits, and unknowingly ships the engine's arbitrary auto-pick for delete/binary/mode conflicts. The `conflicts[]` array carries the kind, but nothing in the worktree warns them; for delete-vs-change the deletion intent is silently reversed.

- **Suggested fix:** Surface non-content conflicts explicitly: write a sidecar/conflict-summary file or block the resolving commit until the user acknowledges each non-content conflict path; at minimum ensure the caller renders conflict.kind prominently and lists affected paths.

- **Verifier evidence:** merge.ts:166-188 (current):\n  if (o && t && o.content_hash === t.content_hash) {\n    keep(o.mode === t.mode ? o : { ...o, mode: 33188 });\n    if (o.mode !== t.mode) conflicts.push({ path, kind: \"mode\" });\n    continue;\n  }\n  if (!o && !t) continue; // both deleted\n  if (!o || !t) {\n    // delete vs change — keep the surviving change, flag the conflict\n    conflicts.push({ path, kind: \"delete-vs-change\" });\n    keep((o ?? t)!);\n    continue;\n  }\n  ... \n  if (looksBinary(baseBytes) || looksBinary(oursBytes) || looksBinary(theirsBytes)) {\n    conflicts.push({ path, kind: \"binary\" });\n    keep(o); // ours wins provisionally; theirs recoverable from its state\n    continue;\n  }\n  const result = diff3Merge(...)  // only this branch embeds markers\n\nworkspaceVcs.ts:759-782 stages result.files and materializes the provisional (marker-free for non-content) tree to targetDir, returning status \"conflicted\" with conflicts.\n\nworkspaceVcs.ts:317-319 (commitHead): `if (pending) { await this.gad().call(\"clearPendingMerge\", ...); }` — no per-conflict acknowledgment; the worktree bytes are recorded as the resolution.\n\nPublishBar.tsx:118-121 renders conflicts but only their paths, never kind:\n  {conflicts.map((c) => c.path).join(\", \")}

### P2-28 — Ref-pinned panel can be served the wrong entry bundle via a referer-less sub-resource request
- **Subsystem:** panel HTTP serving + shell session  
- **Category:** bug  
- **Prior finding:** IN-4 (prior-fix-incomplete)  
- **Locations:** `src/server/panelHttpServer.ts:417-424`, `src/server/panelHttpServer.ts:543-545`, `src/server/panelHttpServer.ts:733-748`  
- **What:** IN-4's recommended altitude fix was to give resource URLs build identity by construction (content-hash the entry bundle, e.g. `entryNames:[name]-[hash]`) and then delete the referer parsers. The current fix instead deletes `findResourceInAnySourceBuild`, KEEPS two referer parsers (refFromReferer + new contextIdFromReferer), and adds an asset-404 guard. Entry bundles are still not content-hashed (`bundle.js` exists in every build). For a panel pinned to an explicit `?ref=state:X`, a sub-resource request that arrives without a Referer header (no-referrer meta, direct fetch, hard reload of the bundle URL) resolves ref=undefined, so `servingCache.get(buildCacheKey(source, undefined))` returns the MAIN-HEAD build and serves main's `bundle.js`/`bundle.css` to the ref-pinned page. Chunks are content-hashed so a content-different chunk 404s (good), but the entry bundle is not, so it is silently cross-served.

- **Impact:** A panel explicitly pinned to an immutable state can execute a different state's entry code on referer-less asset loads — a build-identity/integrity hole for ref-pinned panels (e.g. reproducible/audited builds). Cross-context leak proper is mitigated because contextId no longer selects a build, but ref-pinning is still defeated.

- **Suggested fix:** Content-hash entry bundle names (`entryNames: "[name]-[hash]"`) with the served HTML pointing at the hashed entry, or bake a `/state:{hash}/` segment into the import base, so the bundle URL carries build identity and a referer-less request cannot resolve to a different build. Then the referer heuristics can be removed entirely.

- **Verifier evidence:** src/server/panelHttpServer.ts:412 `const ref = url.searchParams.get("ref") || this.refFromReferer(req) || undefined;`
src/server/panelHttpServer.ts:418 `const build = this.servingCache.get(this.buildCacheKey(parsed.source, ref));`
src/server/panelHttpServer.ts:543-545 `private buildCacheKey(source: string, ref?: string): string { return ref ? \`${source}@${ref}\` : source; }`
src/server/panelHttpServer.ts:744-748 (asset-404 guard, only fires when artifact absent in the *resolved* build): `if (isPanelAssetRequest(resource)) { res.writeHead(404, ...); res.end("Not found"); return; }`
src/server/buildV2/builder.ts:1888-1890 `assetNames: "assets/[name]-[hash]", entryNames: "[name]", chunkNames: "chunk-[hash]",`
src/server/configLoader.ts:136 `bundle.src = "./bundle.js";` (entry bundle URL has no ?ref)
src/server/buildV2/builder.ts:1298 `const baseHref = usePanelLoader ? \`/${relativePath}/\` : null;` (base href carries no ref query)
grep `findResourceInAnySourceBuild` over src/ → NOT FOUND (deleted, confirming the fix did not adopt the content-hash altitude path and instead retained referer heuristics).

### P2-29 — onSourceRebuilt overwrites worker codeVersion with store generation, re-using a loader cache key already populated with stale code
- **Subsystem:** server boot/index + workerdManager + gateway + headless-host  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/workerdManager.ts:2616-2625 (instance.codeVersion = image.generation)`, `src/server/workerdManager.ts:937-962 (update() does codeVersion += 1 without bumping the store)`, `src/server/workerdManager.ts:1063 (getWorkerCode guards with Math.max but the rebuild path does not)`  
- **What:** instance.codeVersion is the loader cache key suffix (`${name}@${codeVersion}`). update() increments instance.codeVersion (line 953) for env/bindings/stateArgs changes WITHOUT rebinding the runtime image, so RuntimeImageStore.generation does not move. onSourceRebuilt then unconditionally assigns instance.codeVersion = image.generation (line 2622). After N update() calls, instance.codeVersion can exceed the store generation; assigning the lower generation reuses a `name@G` cache key the worker host already cached during an earlier update with OLDER code/env. The getWorkerCode rebind callback (line 1063) defends with Math.max(codeVersion+1, generation), but the eager assignments in onSourceRebuilt and createWorker/startWorker (lines 659, 814) do not.

- **Impact:** After a legitimate source rebuild, a worker that was previously update()'d can keep serving a stale cached isolate (old code or old env) because the loader cache key collides with a previously-served version. Silent staleness, no error.

- **Suggested fix:** In onSourceRebuilt (and update/create) set instance.codeVersion = Math.max(instance.codeVersion + 1, image.generation) so the loader key is always strictly fresh, matching the getWorkerCode guard.

- **Verifier evidence:** src/server/workerdManager.ts:2617-2625 (onSourceRebuilt eager assign):
```
for (const instance of this.instances.values()) {
  if (instance.source === source && scopeTracksHead(instance.scopeRef, head)) {
    const image = updateImageFromCompleted(instance.runtimeImageId, instance.scopeRef);
    if (image) {
      instance.buildKey = image.buildKey;
      instance.codeVersion = image.generation;   // line 2622: no Math.max
      this.registerEgressCaller(instance);
    }
  }
}
```

src/server/workerdManager.ts:937-953 (update bumps codeVersion without rebinding when no ref):
```
if (updates.env) instance.env = updates.env;
if (updates.bindings) instance.bindings = updates.bindings;
if (updates.stateArgs !== undefined) instance.stateArgs = updates.stateArgs;
if (updates.ref !== undefined) { ...bindRuntimeImage...; instance.codeVersion = image.generation; }
...
instance.codeVersion += 1;   // line 953: env/bindings-only path bumps cv, generation unchanged
```

src/server/runtimeImageStore.ts:42 (generation is per-image, +1 only on upsert):
```
generation: (previous?.generation ?? 0) + 1,
```

src/server/workerdManager.ts:1658 (loader cache key = name@codeVersion, factory only on miss):
```
const stub = env.LOADER.get(name + "@" + version, async () => { ... GATEWAY.fetch("/_workercode/" + name) ... });
```
where `version` is `instance.codeVersion` returned by getWorkerVersion (workerdManager.ts:1040).

src/server/workerdManager.ts:1063 (the guard that the rebuild path fails to apply):
```
instance.codeVersion = Math.max(instance.codeVersion + 1, record.generation);
```

### P2-30 — Persisted RuntimeImageStore record with an unresolvable scopeRef yields a permanent 503 warming loop, not an actionable status
- **Subsystem:** server boot/index + workerdManager + gateway + headless-host  
- **Category:** incomplete-design  
- **Prior finding:** IN-1 (prior-fix-incomplete)  
- **Locations:** `src/server/workerdManager.ts:374-398 (getRuntimeImageBuild → scheduleRuntimeImageRebind)`, `src/server/workerdManager.ts:346-371 (bindRuntimeImage → deps.bindRuntimeImage → validateBuildRef)`, `src/server/runtimeImageStore.ts:55-77 (load validates field types but not scopeRef validity)`  
- **What:** IN-1 asked that persisted refs flowing into the loader be validated/migrated with an actionable status, not a generic build error. validateBuildRef is now enforced at WRITE time (good). But a persisted runtime-images.json record whose scopeRef later becomes unresolvable (a ctx:<id> whose context folder/head was deleted between runs, or a state:<hash> pruned from the CAS) takes this hot-path: getRuntimeImageBuild throws RuntimeImageWarmingError (→503) and schedules scheduleRuntimeImageRebind, whose bindRuntimeImage rejects (resolveHead null → 'Unknown vcs ref'); the rejection is swallowed by .catch(log.warn) and the flight cleared in finally. The next loader request re-enters, re-schedules, re-fails. The artifact never warms and the gateway serves 503 'code warming' forever with no surfaced error.

- **Impact:** A DO/worker whose pinned context or state was garbage-collected becomes permanently unloadable, reporting only a transient-looking 503 with Retry-After:1 — the client retries indefinitely and the operator gets only buried log.warn lines, never an actionable failure.

- **Suggested fix:** On rebind failure for a persisted image, mark the record errored (or delete it) and have getRuntimeImageBuild surface a terminal error (e.g. 410/500 with the bind error message) after a bounded number of failed warm attempts, instead of looping 503 forever.

- **Verifier evidence:** src/server/workerdManager.ts:384-388 — `this.scheduleRuntimeImageRebind(image, onRebound); throw new RuntimeImageWarmingError(\`Runtime image ${imageId} points at missing artifact ${image.buildKey}; warming\`);` (no terminal branch).
src/server/workerdManager.ts:395-403 — `const flight = this.bindRuntimeImage(image.id, image.source, image.scopeRef).then((record) => onRebound?.(record)).catch((error) => { log.warn(\`Runtime image rebind failed for ${image.id}:\`, error); }).finally(() => { this.runtimeImageRebinds.delete(image.id); });` (failure swallowed, flight cleared, no error state recorded).
src/server/buildV2/index.ts:400-402 — `} else if (ref.startsWith("ctx:")) { const resolved = await source.resolveHead(ref); if (!resolved) throw new Error(\`Unknown vcs ref: ${ref}\`);` (the rejecting path for a deleted ctx head).
src/server/gateway.ts:291-298 — `if ((err as { code?: unknown })?.code === "RUNTIME_IMAGE_WARMING") { res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "1", }); res.end("Worker code warming"); return; }` (maps the warming error to transient 503 forever; same at gateway.ts:358-364 for DOs).
src/server/runtimeImageStore.ts:60-72 — load() validates only `typeof record.id === "string"` … through `updatedAt === "number"`; no scopeRef resolvability check and no error/fail-count field on RuntimeImageRecord (runtimeImageStore.ts:4-14).

### P2-31 — devMirror rsync --delete can destroy untracked files in the source template checkout
- **Subsystem:** server boot/index + workerdManager + gateway + headless-host  
- **Category:** bug  
- **Prior finding:** IN-7 (new-issue)  
- **Locations:** `src/server/index.ts:954-975`  
- **What:** The pnpm-dev template mirror runs `rsync -a --delete --exclude=.git --exclude=node_modules --exclude=.contexts --exclude=.gad --exclude=.cache --exclude=.databases ${workspacePath}/ ${devTemplateMirrorDir}/` on every settled main-head advance. The target devTemplateMirrorDir is the developer's real source checkout under appRoot/workspace. --delete removes any file present in the target but absent from the ephemeral source workspace that is not covered by an exclude — untracked scratch files, locally-added build outputs, editor files, or any new top-level dir not excluded. This silently mutates/deletes the operator's working tree as a side effect of agent commit loops.

- **Impact:** In dogfood/pnpm-dev mode an agent committing in the ephemeral workspace can delete untracked files from the developer's source checkout. Data-loss risk on the very checkout the developer is editing.

- **Suggested fix:** Mirror via the VCS tree (only files the workspace state actually tracks) instead of filesystem rsync --delete, or drop --delete / scope it to known source dirs. At minimum gate behind explicit opt-in and document the destructive semantics.

- **Verifier evidence:** src/server/index.ts:951-977:
```
    if (devTemplateMirrorDir) {
      // Debounced rsync — state advances can arrive in bursts during agent
      // commit loops; mirror once things settle.
      if (devMirrorTimer) clearTimeout(devMirrorTimer);
      devMirrorTimer = setTimeout(() => {
        devMirrorTimer = null;
        const { execFile } = require("node:child_process") as typeof import("node:child_process");
        execFile(
          "rsync",
          [
            "-a",
            "--delete",
            "--exclude=.git",
            "--exclude=node_modules",
            "--exclude=.contexts",
            "--exclude=.gad",
            "--exclude=.cache",
            "--exclude=.databases",
            `${workspacePath}/`,
            `${devTemplateMirrorDir}/`,
          ],
          (err) => {
            if (err) console.warn("[DevMirror] rsync to template failed:", err.message);
          }
        );
      }, 500);
    }
```
Dest endpoint (index.ts, dev-template gating): `const templateDir = path.join(appRoot, "workspace");` and `const devTemplateMirrorDir = isPnpmDevMode && workspaceIsEphemeral && hasDevTemplate && templateDiffersFromActive ? templateDir : null;`
Source endpoint: index.ts:542 `const workspacePath = workspace.path;` → loader.ts:527 `path: sourceRoot,` (the source/ subdir).
Ephemeral copy is source-dirs-only: loader.ts:390-395 copies only WORKSPACE_SOURCE_DIRS; sourceDirs.ts:1-13 lists those 11 dirs (no `dist`).

### P2-32 — CLI `vcs commit --repo X` silently commits the entire context tree, not the named unit
- **Subsystem:** vcs RPC service + CLI + schemas  
- **Category:** expectation-violation  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/cli/agent/vcsCommands.ts:102-125`, `src/server/services/vcsService.ts:178-217`  
- **What:** `natstack vcs status --repo panels/notes` and `natstack vcs diff --repo panels/notes` scope their output to the named unit via `vcs.unitStatus`, showing only files under that path. But `natstack vcs commit --repo panels/notes -m "x"` calls `vcs.commit(repo, message, {head})`, and the server commit handler treats `repoPath` as purely advisory: it snapshots the WHOLE working tree in a single transition (vcsService.ts:178-181 comment: "the whole tree is snapshotted in one transition; the path scopes the build-events pointer"). So a user who reviews `vcs status --repo panels/notes`, sees only notes files dirty, and then runs `vcs commit --repo panels/notes` will unknowingly fold every other dirty file across the context into that commit.

- **Impact:** A user/agent reasoning per-unit (the entire premise of the `--repo` flag and the per-unit status/diff commands) commits unrelated changes from sibling units under a message that names one unit. Integrity/auditability of commit scope is broken; there is no way to commit just one unit via the CLI.

- **Suggested fix:** Either make the CLI/commit path scope the snapshot to the unit (stage only paths under repoPath) or change the CLI surface to not present `--repo` as a commit scope: document that commit is always whole-context and have `vcs status`/`vcs diff` warn that commit is not unit-scoped. At minimum the commit confirmation/human output should list all changed paths, not imply unit scope.

- **Verifier evidence:** CLI commit (whole-tree intent lost): src/cli/agent/vcsCommands.ts:112-116 `const result = await client.call<VcsCommitResult>("vcs.commit", [ repo, message, { head }, ]);`

Server treats repoPath as advisory: src/server/services/vcsService.ts:179-181 `// The repoPath arg (e.g. "panels/my-app") is advisory under the // single-workspace-tree model: the whole tree is snapshotted in // one transition; the path scopes the build-events pointer.` ... :187-188 `const head = resolveWriteHead(ctx, deps, options?.head); const result = await vcs.commitHead(head, {` — repoPath only reused at :198-216 for `buildEventsQuery.args`.

Whole-tree snapshot: src/server/gadVcs/workspaceVcs.ts:260 `const dir = this.dirForHead(head);` :289 `const snap = await this.vcs.snapshotDir(dir, {` ; dirForHead at :232-236 returns `this.deps.workspaceRoot` / `this.contextDir(head.slice(4))` (no unit path).

Read commands ARE unit-scoped (the asymmetry): src/cli/agent/vcsCommands.ts:65 `const result = await client.call<RepoStatus>("vcs.unitStatus", [repo, head]);` and :92 same for diff; src/server/services/vcsStatus.ts:24 `const within = (p: string) => p === unitPath || p.startsWith(`${unitPath}/`);` filtering files at :26-28.

### P2-34 — Gmail agent prompt instructs it to call `close_turn_without_response` (and use ask_user), but those tools are no longer registered
- **Subsystem:** vessel workers (gmail/silent/agent-worker/hello)  
- **Category:** bug  
- **Prior finding:** CAP-2 (prior-fix-incomplete)  
- **Locations:** `workspace/workers/gmail-agent/gmail-agent-worker.ts:249-266`, `workspace/packages/agentic-do/src/agent-vessel.ts:838-850`, `workspace/packages/agentic-do/src/agent-worker-base.ts:126-160`  
- **What:** GMAIL_SYSTEM_PROMPT (prompts.ts) explicitly tells the agent: "call close_turn_without_response instead of sending a visible reply." In the new vessel surface, `toolRegistry` (agent-vessel.ts:842-846) force-registers ONLY `memory_recall`, then adds whatever `getLoopTools` returns. The base `AgentWorkerBase.getLoopTools` bundles `close_turn_without_response`, `ask_user`, the six file tools and web tools — but GmailAgentWorker OVERRIDES `getLoopTools` to return ONLY `GMAIL_TOOLS` (which contains no close_turn/ask_user). So `close_turn_without_response` is absent from the gmail registry while the (now also appended) prompt instructs the model to call it. The model emits a tool call the local-tool executor cannot resolve.

- **Impact:** In multi-agent channels the Gmail agent cannot perform the prompted no-op turn-close; the tool call errors instead of cleanly terminating, producing failed invocations or spurious chatter. The architectural trap: bundling close_turn/ask_user into the same getLoopTools as the file tools means any vessel that overrides getLoopTools to swap tool sets silently loses these universal turn-control tools.

- **Suggested fix:** Force-register `close_turn_without_response` (and `ask_user`) alongside `memory_recall` in `toolRegistry`, independent of getLoopTools overrides; or have gmail's getLoopTools return turn-control tools plus GMAIL_TOOLS. Add a test asserting close_turn_without_response is in gmail's registry.

- **Verifier evidence:** agent-worker-base.ts:135-159 base getLoopTools returns [...file tools, createCloseTurnWithoutResponseTool() (line 142), this.createAskUserTool() (line 143), ...createWebTools(...)]. gmail-agent-worker.ts:249-251 `protected override getLoopTools(channelId: string): AgentTool[] { return GMAIL_TOOLS.map(...` — returns ONLY GMAIL_TOOLS, no super call. agent/tools.ts:121-215 GMAIL_TOOLS names are all gmail_* (gmail_checkInbox, gmail_search, gmail_send, ...), none is close_turn_without_response or ask_user. agent-vessel.ts:841-846 `registry = new Map(); registry.set("memory_recall", this.createMemoryRecallTool()); for (const tool of this.getLoopTools(channelId)) { registry.set(tool.name, tool); }`. agent-vessel.ts:706-712 schemas built from `[...registry.values()].map(tool => ({ name: tool.name, ... }))`. agent-vessel.ts:491-493 `if (!agentTool) { return { result: \`unknown tool: ${tool}\`, isError: true }; }`. prompts.ts:24 "...call close_turn_without_response instead of sending a visible reply." system-prompt.ts:19 (NATSTACK_BASE_SYSTEM_PROMPT, appended by default) "...use \`close_turn_without_response\` instead of sending a visible reply." silent-agent-worker/index.ts:45 `const tools = [...super.getLoopTools(channelId), this.createSayTool(channelId)];` (the correct pattern gmail omits).

### P2-35 — Transient fs read error now hard-blocks all Gmail UI/renderer installation
- **Subsystem:** vessel workers (gmail/silent/agent-worker/hello)  
- **Category:** bug  
- **Prior finding:** none (not-applicable)  
- **Locations:** `workspace/workers/gmail-agent/gmail-agent-worker.ts:660-688`, `workspace/workers/gmail-agent/gmail-agent-worker.ts:603-606`  
- **What:** `lintRendererSources` previously caught a failed `fs.readFile` and did `console.warn(...); continue;` with an explicit comment: "a transient fs problem must not block UI install (the panel reads the file itself at compile time)." The new code removes that comment and instead pushes a failure on BOTH the catch path (line 671-675) and the null-text path (line 677-679), then throws `Gmail renderer registration blocked` if `failures.length > 0`. `lintRendererSources()` is awaited at the top of `installChannelUi` (line 606) before any messageType.registered / action-bar events are published.

- **Impact:** A transient fs/RPC read failure (exactly the eviction-prone fault path in this hibernation-first runtime) now aborts the entire Gmail UI install for the channel — no message-type renderers, no action bar — rather than degrading gracefully as the prior design explicitly intended. The change conflates 'unreadable due to transient error' with 'has an unsatisfiable import'.

- **Suggested fix:** Distinguish lint failures (bad imports) from read failures: keep throwing for genuine lint issues, but warn-and-continue (or retry) on fs read errors so a transient read does not block UI registration.

- **Verifier evidence:** gmail-agent-worker.ts:671-679 (current): `} catch (err) {\n          failures.push(\n            \`${path}: source unreadable (${err instanceof Error ? err.message : String(err)})\`\n          );\n          continue;\n        }\n        if (code === null) {\n          failures.push(\`${path}: source unreadable (fs.readFile did not return text)\`);\n          continue;\n        }`. gmail-agent-worker.ts:685-687: `if (failures.length > 0) {\n        throw new Error(\`Gmail renderer registration blocked:\\n${failures.join("\\n")}\`);\n      }`. gmail-agent-worker.ts:606: `await this.lintRendererSources();` (top of installChannelUi, before any publishAgenticEvent at 623/644). gmail-agent-worker.ts:341: `await this.installChannelUi(opts.channelId);` inside subscribeChannel. The removed prior code (git diff HEAD): `-      } catch {\n-        /* fall through */\n-      }` and `-        // Can't lint what we can't read — a transient fs problem must not\n-        // block UI install (the panel reads the file itself at compile time).\n-        console.warn(\`[GmailAgentWorker] renderer lint skipped (unreadable): ${path}\`);`. RPC-backed read: rpcFs.ts:72-73 `async readFile(path: string, encoding?: BufferEncoding) { const result = await call<...>("readFile", path, encoding);`

### P2-36 — web_read corrupts non-ASCII content at byte-range boundaries (CAP-6 fix incomplete)
- **Subsystem:** web-search harness tools + tool-vcs  
- **Category:** bug  
- **Prior finding:** CAP-6 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/harness/src/web/index.ts:313-322`, `src/server/services/blobstoreService.ts:415-423`, `src/server/services/blobstoreService.ts:207-236`  
- **What:** web_read advertises byte-addressed offset/limit and calls blobstore.getRange(digest, off, len). The server's getByteRange reads an ARBITRARY byte window from the file (handle.read(buf,0,cappedLength,offset)) and then does bytes.toString("utf8") (blobstoreService.ts:422). When `offset` lands inside a multi-byte UTF-8 codepoint, or `offset+len` cuts one, toString("utf8") emits U+FFFD replacement characters at the boundaries. The CAP-6 fix correctly moved offsets to bytes (size/head_length are reported in bytes), but the read path is still lossy: any web_read into the middle of a page with non-ASCII content (accented Latin, CJK, emoji, smart quotes — extremely common on real web pages and in extracted markdown) returns garbage bytes at both ends. The blobstore already exposes getRangeBytes (base64, byte-exact) for exactly this reason (blobstore.ts schema comment says 'getRangeBytes if you need a raw binary slice'), but web_read uses the lossy getRange.

- **Impact:** On any non-ASCII page, drilling into a cached blob with web_read returns text with replacement characters at the start/end of every slice, and the corrupted bytes shift if the model re-pages — the model reads garbage and cannot reliably reconstruct the page. The whole point of digest-based paging (read large pages without re-fetching) is unreliable for the majority of real-world (non-pure-ASCII) content.

- **Suggested fix:** Either (a) have web_read call blobstore.getRangeBytes and decode with a streaming TextDecoder that tolerates/snaps boundaries, returning the actual byte count consumed; or (b) add a codepoint-snapping mode to getByteRange so the returned slice never splits a UTF-8 sequence (and report the true byte span consumed). Do not toString('utf8') an arbitrary byte window.

- **Verifier evidence:** web/index.ts:313-315: `const slice = await deps.rpc.call<string | null>("main", "blobstore.getRange", [digest, off, len]);` (off computed as arbitrary byte offset at web/index.ts:311). blobstoreService.ts:227: `await handle.read(buf, 0, cappedLength, offset);` then blobstoreService.ts:415-422 getRange case: `const bytes = await getByteRange(...); return bytes ? bytes.toString("utf8") : null;`. getRangeBytes (byte-exact, unused by web_read) at blobstoreService.ts:424-431. Documented-intentional lossiness at serviceSchemas/blobstore.ts:62-66: "partial codepoints at slice boundaries become U+FFFD replacement chars ... Use getRangeBytes if you need a raw binary slice." Byte-addressed advertisement at web/index.ts:100 ("Byte offset to start reading from") and :105 ("Maximum number of bytes to read").

### P2-37 — web_read reports UTF-16 string length as the byte count, breaking byte-offset pagination
- **Subsystem:** web-search harness tools + tool-vcs  
- **Category:** bug  
- **Prior finding:** CAP-6 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/harness/src/web/index.ts:319-322`  
- **What:** web_read returns details: { digest, offset: off, limit: len, bytes: slice.length }. `slice` is the decoded JS string returned from blobstore.getRange, so slice.length is the number of UTF-16 code units, NOT the number of bytes consumed from the blob. The tool's contract (READ_PARAMETERS) defines offset and limit in BYTES, and web_fetch reports size/head_length in bytes. For any multibyte content, slice.length < bytes-consumed, so a model that computes its next offset as offset + bytes (the only quantity web_read hands back to describe progress) will under-advance and re-read overlapping content, or stall. This is the same byte/char confusion CAP-6 set out to eliminate, surviving in the result metadata.

- **Impact:** Sequential paging through a large non-ASCII page via web_read drifts: the model re-reads or skips regions because the reported `bytes` is a char count, not a byte count. Combined with the boundary-corruption bug above, multi-chunk reads of real pages are unreliable.

- **Suggested fix:** Return the true number of bytes consumed (e.g. utf8ByteLength(slice) if staying on getRange, or the decoded byte span if switching to getRangeBytes) and ideally a next_offset field so the model never has to infer byte arithmetic from a string length.

- **Verifier evidence:** workspace/packages/harness/src/web/index.ts:321: `details: { digest, offset: off, limit: len, bytes: slice.length },` where `slice` is `await deps.rpc.call<string | null>("main", "blobstore.getRange", [digest, off, len])` (index.ts:313-315) — a decoded UTF-8 string, so `.length` is UTF-16 code units, not bytes.

Contract is in bytes — index.ts:100 `description: "Byte offset to start reading from (default 0)."`, index.ts:105 `description: \`Maximum number of bytes to read ...\``.

Source returns bytes-then-decode — src/server/services/blobstoreService.ts:227 `await handle.read(buf, 0, cappedLength, offset);` and :422 `return bytes ? bytes.toString("utf8") : null;`.

A correct byte-length helper already exists and is used by web_fetch — index.ts:358-359 `function utf8ByteLength(text: string): number { return textEncoder.encode(text).byteLength; }`, and web_fetch reports `head_length: head.byteLength` (index.ts:288).

Code is untracked/new (`?? workspace/packages/harness/src/web/`), confirming it is current uncommitted code.

### P2-38 — PDF/Readability extraction runs with no timeout after fetch, so a giant body can pin the effect lease (CAP-7 only covers the fetch)
- **Subsystem:** web-search harness tools + tool-vcs  
- **Category:** bug  
- **Prior finding:** CAP-7 (prior-fix-incomplete)  
- **Locations:** `workspace/packages/harness/src/web/extract.ts:49-81`, `workspace/packages/harness/src/web/index.ts:376-406`  
- **What:** CAP-7's withAbort wraps only the network fetch with a 30s timeout and the executor signal. But after fetch resolves, extractPage performs unbounded CPU/memory work that is NOT covered by any timeout: pdfToMarkdown loads the entire body into memory and runs unpdf (extract.ts:50-51,83-114), and htmlToReadableMarkdown parses the full HTML twice with linkedom + Readability (extract.ts:124-150). The fetch timeout's clearTimeout fires once the Response is returned, so a multi-hundred-MB PDF or a pathological HTML document hangs parsing with no abort path. In the hibernation-first driver this synchronous-ish parse holds the effect lease with no deadline.

- **Impact:** A single hostile or merely huge URL (large PDF / adversarial HTML) can pin a web_fetch effect indefinitely, blocking the agent turn and the lease; the 30s fetch timeout gives a false sense of bounded execution.

- **Suggested fix:** Bound the response body size (cap arrayBuffer()/text() length before parsing) and/or check signal.aborted between extraction phases; consider a wall-clock budget around extractPage as a whole, not just the fetch.

- **Verifier evidence:** index.ts:397-404 (withAbort): `try { return await fetcher(input as never, { ...init, signal: controller.signal }); } finally { clearTimeout(timeout); outer?.removeEventListener("abort", abort); ... }` — timeout cleared as soon as the Response returns, before the body is read. index.ts:262: `const page = await extractPage(url, withAbort(fetcher, signal) as never, signal);`. extract.ts:31: `const res = await fetcher(url, {...})` (resolves the Response -> clears timeout). extract.ts:49-51: `if (looksLikePdf) { const buf = await res.arrayBuffer(); return await pdfToMarkdown(new Uint8Array(buf), finalUrl); }` — unbounded body read + unpdf parse with no timeout/signal. extract.ts:79-80: `const html = await res.text(); return htmlToReadableMarkdown(html, finalUrl);`. extract.ts:124-150 htmlToReadableMarkdown parses full HTML twice (`parseHTML(html)` line 125, `new Readability(...)` line 132, `parseHTML(\`<div>${contentHtml}</div>\`)` line 147) and takes no signal. No Content-Length / byte cap exists before arrayBuffer()/text(); MAX_READ_LIMIT (index.ts:105) applies only to the web_read tool.

---

## P3 findings

### P3-40 — validateInternalDepSpec throws synchronously during graph discovery, aborting the entire build system on a single non-default workspace dep spec
- **Subsystem:** buildV2 (state trigger, refs, buildSource, index, builder)  
- **Category:** expectation-violation  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/buildV2/packageGraph.ts:152-165`, `src/server/buildV2/packageGraph.ts:218-221`, `src/server/buildV2/packageGraph.ts:333-335`  
- **What:** parseInternalDepRef (which previously tolerated workspace:<branch>, commit, ref, refs/ specs) was replaced by validateInternalDepSpec, which throws `Internal dependency X must use workspace:*` for ANY non-default spec. This is called unguarded inside scanDirectory (packageGraph.ts:220) and the post-scan internal-dep pass (packageGraph.ts:334), both inside discoverPackageGraph. A single workspace package.json declaring e.g. `"@workspace/foo": "workspace:somebranch"` or a commit-pinned internal dep will throw and abort discoverPackageGraph entirely — which means initBuildSystemV2 (index.ts:247), every rediscoverAt, and every ctx discoverGraph fail, taking down all builds, not just the offending unit. No workspace package currently uses such a spec, so it is latent, but the failure mode is total rather than per-unit.

- **Impact:** One stray legacy/typo'd internal dependency spec anywhere in the workspace hard-fails graph discovery, bricking the whole build system (cold start and every subsequent state advance) instead of degrading one unit.

- **Suggested fix:** Either record the validation error on the node (and skip/treat as workspace:* with a diagnostic) so discovery still completes, or only throw for explicitly invalid (non-empty, non-workspace) specs while logging-and-defaulting the legacy workspace:<x> forms. At minimum wrap per-dep validation so one bad spec doesn't abort discovery of the entire workspace.

- **Verifier evidence:** packageGraph.ts:160-162: `throw new Error(\n    \`Internal dependency ${depName} must use workspace:*; GAD workspace builds do not support per-dependency refs\`\n  );`
packageGraph.ts:219-223 (scanDirectory): `for (const [depName, depSpec] of Object.entries(allDeps)) {\n      if (isInternalDep(depName)) {\n        internalDeps.push(depName);\n        validateInternalDepSpec(depName, depSpec);\n      }\n    }`
packageGraph.ts:331-336 (post-scan pass): `for (const node of graph.allNodes()) {\n    for (const [depName, depSpec] of Object.entries(node.dependencies)) {\n      if (!graph.has(depName) || node.internalDeps.includes(depName)) continue;\n      node.internalDeps.push(depName);\n      validateInternalDepSpec(depName, depSpec);\n    }\n  }`
workspaceVcs.ts:411-414: `async discoverGraph(stateHash: string): Promise<PackageGraph> {\n    const sourceRoot = await this.materializeStateForGraphDiscovery(stateHash);\n    return discoverPackageGraph(sourceRoot);\n  }` (no try/catch)
index.ts:247: `const graph = await source.discoverGraph(stateHash);` (unguarded inside initBuildSystemV2)
packageGraph.test.ts:225: `expect(() => discoverPackageGraph(root)).toThrowError(/per-dependency refs/);` — confirms the throw-aborts-discovery behavior is intentional and tested (the offending spec there is `"@workspace/runtime": "workspace:main"`).
Workspace scan: zero @workspace/@workspace- deps with a non-default spec found across all workspace/**/package.json — confirms latency.

### P3-41 — recomputeFromNode (single-node wrapper) is now dead in production code
- **Subsystem:** buildV2 (state trigger, refs, buildSource, index, builder)  
- **Category:** cleanup  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/buildV2/effectiveVersion.ts:138-150`  
- **What:** After the rewrite, all production callers use recomputeFromNodes (the batch form). recomputeFromNode (the single-node convenience wrapper) is only referenced by effectiveVersion.test.ts:9,106 — no production path imports it (grep over src/ and packages/ shows only the test). It is retained, harmless, but is dead surface that suggests an incomplete migration.

- **Impact:** Minor: dead exported API kept alive solely by a test; no functional effect.

- **Suggested fix:** Remove recomputeFromNode and inline recomputeFromNodes([name],…,{[name]:hash}) in the test, or keep but mark @internal/test-only.

- **Verifier evidence:** src/server/buildV2/effectiveVersion.ts:138-149:
```
/** Single-node convenience wrapper over {@link recomputeFromNodes}. */
export function recomputeFromNode(
  graph: PackageGraph,
  nodeName: string,
  currentEvMap: EffectiveVersionMap,
  contentHashes: ContentHashMap,
  newHash: string
): { evMap: EffectiveVersionMap; contentHashes: ContentHashMap } {
  return recomputeFromNodes(graph, [nodeName], currentEvMap, contentHashes, {
    [nodeName]: newHash,
  });
}
```
grep `recomputeFromNode\b` (single-node) hits only: effectiveVersion.ts:139 (def), effectiveVersion.test.ts:9 (import), effectiveVersion.test.ts:106 (call) — no production callers.
Production uses the batch form instead: src/server/buildV2/stateTrigger.ts:270 and :316 `const result = recomputeFromNodes(...)`, imported at stateTrigger.ts:19 and index.ts:23.

### P3-42 — Stale BUILD_SYSTEM.md directory tree lists deleted about/dirty-repo panel
- **Subsystem:** cross-cutting: dangling references to deleted modules  
- **Category:** cleanup  
- **Prior finding:** CL-9 (prior-fix-incomplete)  
- **Locations:** `BUILD_SYSTEM.md:242`  
- **What:** The illustrative workspace directory tree in BUILD_SYSTEM.md still lists `dirty-repo/` under `about/` as a shipped shell panel. The `workspace/about/dirty-repo/` directory was deleted in this changeset. Doc-only (no build/runtime impact), but it advertises a panel that no longer exists, which is misleading given the unified-log rewrite removed the git-based dirty-repo/git-init about panels.

- **Impact:** Documentation drift; a developer reading BUILD_SYSTEM.md would expect a dirty-repo about panel to exist and could try to wire to it.

- **Suggested fix:** Remove the `dirty-repo/` line from the about/ tree in BUILD_SYSTEM.md (or replace with the current VCS panel name if one exists).

- **Verifier evidence:** BUILD_SYSTEM.md:240-244 (current file): `├── about/                 ← shell panels (browser target, shell service access)` / `│   ├── about/` / `│   ├── dirty-repo/`  ← line 242 / `│   ├── model-provider-config/` / `│   └── ...`. The directory was deleted: `git status --short` shows `D workspace/about/dirty-repo/DirtyRepoView.tsx`, `D workspace/about/dirty-repo/index.tsx`, `D workspace/about/dirty-repo/package.json`, and `ls workspace/about/dirty-repo/` returns "No such file or directory". The current workspace/about/ contains only: about, adblock, help, keyboard-shortcuts, new. `git diff HEAD -- BUILD_SYSTEM.md | grep dirty-repo` returns no match (exit 1), confirming the stale line was not corrected in this changeset.

### P3-43 — knowledge theory/edge/contradiction projection tables are created and cleared but never written or read (dead feature)
- **Subsystem:** gad-store DO (unified log core, schema v16)  
- **Category:** incomplete-design  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/workers/gad-store/index.ts:1146-1185 (gad_claim_edges/gad_theories/gad_theory_versions/gad_contradictions DDL)`, `workspace/workers/gad-store/index.ts:2630-2687 (projectKnowledge)`, `workspace/workers/gad-store/index.ts:5867-5873 (knowledge.theory_*/claim_edge_*/contradiction_* in STORED_EVENT_KINDS)`  
- **What:** STORED_EVENT_KINDS accepts knowledge.theory_proposed/versioned/superseded, knowledge.claim_edge_added/removed, and knowledge.contradiction_recorded/resolved, so these events validate and are stored in the log. applyProjections routes all knowledge.* kinds to projectKnowledge, but projectKnowledge returns early unless the kind starts with 'knowledge.claim_' (recorded/updated/retracted). The four tables gad_theories, gad_theory_versions, gad_claim_edges, gad_contradictions are declared, listed in GAD_REQUIRED_TABLES, and wiped by clearProjections — but no code path ever INSERTs into them, and no query method ever reads from them (grep for FROM gad_theor*/gad_claim_edges/gad_contradictions returns nothing).

- **Impact:** The semantic-sidecar theory/edge/contradiction surface is silently unimplemented: agents can emit these events (and the raw events persist in the log), but the derived tables are permanently empty, so any consumer expecting to query theories/edges/contradictions gets nothing. A green test suite misses this because no test queries those tables.

- **Suggested fix:** Either implement projectors for theory/edge/contradiction kinds (mirroring projectKnowledge's claim handling) and add reader methods, or drop the four unused tables from the schema and remove the unhandled kinds from STORED_EVENT_KINDS so the surface no longer claims a feature it does not provide.

- **Verifier evidence:** projectKnowledge early-return gating only claim_* (index.ts:2630-2649):\n```\n2630  private projectKnowledge(envelope: LogEnvelope): void {\n2631    const payload = envelope.payload as JsonRecord;\n2632    if (!envelope.payloadKind.startsWith("knowledge.claim_")) return;\n...\n2644    if (\n2645      envelope.payloadKind !== "knowledge.claim_recorded" &&\n2646      envelope.payloadKind !== "knowledge.claim_updated"\n2647    ) {\n2648      return;\n2649    }\n```\nRouting catches all knowledge.* (index.ts:2147-2148): `if (kind.startsWith("knowledge.")) { this.projectKnowledge(envelope); }`.\nUnhandled kinds still stored (index.ts:5867-5873): knowledge.theory_proposed, theory_versioned, theory_superseded, claim_edge_added, claim_edge_removed, contradiction_recorded, contradiction_resolved.\nTables declared (index.ts:1147-1185: gad_claim_edges, gad_theories, gad_theory_versions, gad_contradictions), required (index.ts:78-81), cleared (index.ts:4356-4359). grep for `INSERT INTO gad_theor|gad_claim_edges|gad_contradictions` and `FROM gad_theor|FROM gad_claim_edges|FROM gad_contradictions` returns no write or read — only the list/DDL/clear references.

### P3-44 — navigate RPC double-navigates the panel if the active host command resolves null/undefined
- **Subsystem:** panel HTTP serving + shell session  
- **Category:** bug  
- **Prior finding:** none (not-applicable)  
- **Locations:** `src/server/panelRuntimeRegistration.ts:371-389`, `src/server/panelRuntimeRegistration.ts:538-554`  
- **What:** `navigateViaActiveHost` returns `Promise<unknown | null>` and the navigate case branches on `if (hosted !== null)`. The three preflight early-returns correctly yield `null` (no holder / not connected / not registered) to fall through to `panelManager.navigate`. But once preflight passes it returns `cdpBridge.sendHostCommand(panelId, "navigatePanel", ...)` directly. Today the headless host's navigatePanel returns `{id,title}` (non-null), so this is safe in practice. However the contract uses `null` as the sentinel for "not hosted" while the host command's result is untyped; if any host implementation (or an error-swallowing transport) ever resolves the hosted navigate to `null`/`undefined`, the code treats a SUCCESSFUL host navigation as "not hosted" and runs `panelManager.navigate` a second time, double-navigating the panel.

- **Impact:** Latent double-navigation / inconsistent panel state on a fragile, easy-to-trip sentinel. The hosted vs non-hosted distinction rides on a value that another team owns and that JSON transport can turn into null.

- **Suggested fix:** Make `navigateViaActiveHost` return a discriminated result (e.g. `{ handled: true, result } | { handled: false }`) instead of overloading `null`, and branch on `handled` so a null/undefined host response still counts as handled.

- **Verifier evidence:** src/server/panelRuntimeRegistration.ts:382 `): Promise<unknown | null> => {` and the preflight sentinels at 384 `if (!holder?.supportsCdp) return null;`, 386 `if (!cdpBridge.isProviderConnected(holder.hostConnectionId)) return null;`, 387 `if (!cdpBridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)) return null;`, then 388 `return cdpBridge.sendHostCommand(panelId, "navigatePanel", [source, options ?? {}]);`. Consumed at src/server/panelRuntimeRegistration.ts:542-548: `const hosted = await navigateViaActiveHost(panelId, source, options); if (hosted !== null) { ... return hosted; } const result = await panelManager.navigate(asPanelSlotId(panelId), source, options);`. Safe today because apps/headless-host/src/headlessHost.ts:274 `return { id: result.panelId, title: result.title };` (always non-null) and apps/headless-host/src/panelInitClient.ts:152 `): Promise<CreatePanelResult> {`.

### P3-45 — Dead/redundant per-command branches in panel CDP drive()
- **Subsystem:** panel HTTP serving + shell session  
- **Category:** cleanup  
- **Prior finding:** none (not-applicable)  
- **Locations:** `src/server/panelRuntimeRegistration.ts:969-986`  
- **What:** The `drive` handler added explicit branches for `goBack`, `goForward`, and `reload` (lines 976-984) that each `return bridge.sendTargetCommand(panelId, requesterEntityId, command, args)` — byte-for-byte identical to the default fall-through at line 985. Only the `navigate` branch adds value (a URL presence check). The three middle branches are pure dead code.

- **Impact:** Reader confusion and false impression that goBack/goForward/reload have special handling; future edits may diverge them inconsistently.

- **Suggested fix:** Delete the goBack/goForward/reload branches and rely on the default `return bridge.sendTargetCommand(...)`; keep only the navigate URL-validation branch.

- **Verifier evidence:** src/server/panelRuntimeRegistration.ts:969-986:
```
          drive: async (panelId, requesterEntityId, command, args) => {
            await ensureCdpTargetReady(panelId);
            if (command === "navigate") {
              const url = typeof args[0] === "string" ? args[0] : "";
              if (!url) throw new Error("Panel navigation URL is required");
              return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
            }
            if (command === "goBack") {
              return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
            }
            if (command === "goForward") {
              return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
            }
            if (command === "reload") {
              return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
            }
            return bridge.sendTargetCommand(panelId, requesterEntityId, command, args);
          },
```
The goBack/goForward/reload branches (lines 976-984) are byte-for-byte identical to the default return at line 985. `git diff HEAD` confirms these branches are newly added uncommitted code.

### P3-46 — PanelHandle.on() event delivery becomes async + storms metadata RPCs when rpcTargetId is null
- **Subsystem:** runtime wiring (context folders, fsService, vcsClient, durable-base)  
- **Category:** bug  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/packages/runtime/src/shared/handles.ts:155-167`, `workspace/packages/runtime/src/shared/handles.ts:60-72`, `workspace/packages/runtime/src/shared/handles.ts:91-98`  
- **What:** The rpcTargetId fallback was changed from `metadata.rpcTargetId ?? metadata.id` to `?? null` across durable-base, createRuntime, and normalizeMetadata. handles.ts now resolves the target lazily. In `on(event, listener)`, when `metadata.rpcTargetId` is null the listener path becomes `void resolveRpcTargetId().then(targetId => { if (caller===targetId) listener(payload) })`. This has two problems: (1) event delivery is now asynchronous and can reorder when two events for the same handle arrive back-to-back before resolution settles; (2) `resolveRpcTargetId()` calls `refreshMetadata()` which fires a `metadata` RPC, and `refreshMetadata` resets `rpcTargetResolvePromise=null` at the end, so if the panel is still unloaded (runtimeEntityId stays null) EVERY globally-received rpc event re-triggers a fresh `metadata` round-trip — an O(events) RPC storm for any handle whose panel is not loaded.

- **Impact:** For handles to unloaded panels with an active `.on()` subscription, each inbound rpc event triggers a server `metadata` call (latency + load amplification), and event ordering is no longer guaranteed. Loaded-panel handles take the synchronous fast path and are unaffected.

- **Suggested fix:** Cache the negative resolution (memoize that rpcTargetId resolved to the fallback metadata.id) so repeated events don't re-refresh; and/or resolve the target once at subscription time rather than per-event, re-resolving only on refresh()/ensureLoaded(). Preserve synchronous delivery by binding the resolved targetId when the subscription is created.

- **Verifier evidence:** handles.ts:155-165 (current):
    on(event: string, listener: (payload: unknown) => void): () => void {
      return rpc.on(event, (ev: RpcEventContext) => {
        if (metadata.rpcTargetId) {
          if (ev.caller.callerId === metadata.rpcTargetId) listener(ev.payload);
          return;
        }
        void resolveRpcTargetId().then((targetId) => {
          if (ev.caller.callerId === targetId) listener(ev.payload);
        });
      });
    },

handles.ts:87-99:
  const refreshMetadata = async (): Promise<Required<PanelHandleMetadata>> => {
    if (ops?.refresh) {
      metadata = normalizeMetadata({ ...metadata, ...(await ops.refresh(metadata.id)) });
    }
    rpcTargetResolvePromise = null;   // reset after each resolution
    return metadata;
  };
  const resolveRpcTargetId = async (): Promise<string> => {
    if (metadata.rpcTargetId) return metadata.rpcTargetId;
    if (!ops?.refresh) return metadata.id;
    rpcTargetResolvePromise ??= refreshMetadata().then((fresh) => fresh.rpcTargetId ?? fresh.id);
    return rpcTargetResolvePromise;
  };

handles.ts:399: `rpcTargetId: metadata.rpcTargetId ?? null,` (was `?? metadata.id` per git diff HEAD).

packages/rpc/src/client.ts:597-608 — rpc.on is a global per-event-name listener set, no caller filtering at transport.

packages/shared/src/shell/panelManager.ts:1271-1273 — getCurrentEntityId resolves slot.current_entity_id (present for existing panels; throws if absent), so refresh yields a non-null runtimeEntityId for real panels, switching on() to the sync fast path. createRuntime.ts:97 / durable-base.ts:512 map `rpcTargetId: item.runtimeEntityId ?? null`.

src/server/panelRuntimeRegistration.ts:415 — metadata RPC returns null (-> rpcTargetId stays null) only for missing/closed panels.

### P3-47 — events.ts payload type for vcs:head:* is narrower than the actual emitted/consumed VcsHeadAdvance
- **Subsystem:** runtime wiring (context folders, fsService, vcsClient, durable-base)  
- **Category:** cleanup  
- **Prior finding:** none (new-issue)  
- **Locations:** `packages/shared/src/events.ts:197`, `packages/shared/src/serviceSchemas/vcs.ts:182-212`, `src/server/index.ts:927-928`  
- **What:** `events.ts:197` declares the `vcs:head:${string}` event payload as `{ head: string; stateHash: string; changedPaths: string[] }`, but the server actually emits the full `StateAdvancedEvent` (transitionKind, fileChanges, editOps, sinceStateHash, eventId, headHash, actor, ...) and the vcsClient casts the received payload to the much richer `VcsHeadAdvance`. The runtime payload is correct (full object is emitted); only the TypeScript declaration is wrong/narrow, which gives false type-safety to any consumer that trusts the EventPayloads map.

- **Impact:** No runtime break; consumers reading via vcsClient get the full object. A consumer reading the typed EventPayloads map directly would see a too-narrow type and miss fields, or a maintainer could 'optimize' the emit to match the narrow type and silently break vcsClient consumers.

- **Suggested fix:** Align events.ts EventPayloads['vcs:head:*'] with vcsHeadAdvanceSchema (z.infer<typeof vcsHeadAdvanceSchema>) so the declared payload matches what is emitted and consumed.

- **Verifier evidence:** packages/shared/src/events.ts:197 — `[key: `vcs:head:${string}`]: { head: string; stateHash: string; changedPaths: string[] };` (only 3 fields).

src/server/index.ts:927-928 — `workspaceVcs.onStateAdvanced((event) => { eventService.emit(`vcs:head:${event.head}`, event); });` emits the full event.

src/server/buildV2/stateTrigger.ts:33-66 — `StateAdvancedEvent` has head, stateHash, sinceStateHash, eventId, headHash, actor, transitionKind, changedPaths, fileChanges, editOps (10 fields).

workspace/packages/runtime/src/shared/vcsClient.ts:65 — `const off = events.on(`event:${topic}`, (ev) => onAdvance(ev.payload as VcsHeadAdvance));` casts to the richer VcsHeadAdvance.

packages/shared/src/serviceSchemas/vcs.ts:182-212 — `vcsHeadAdvanceSchema` / `VcsHeadAdvance` mirrors the full StateAdvancedEvent shape.

### P3-48 — Dangling JSDoc comment for removed getGitHandler in GatewayDeps
- **Subsystem:** server boot/index + workerdManager + gateway + headless-host  
- **Category:** cleanup  
- **Prior finding:** none (new-issue)  
- **Locations:** `src/server/gateway.ts:147`  
- **What:** The `getGitHandler?` field was removed but its JSDoc `/** Dynamic in-process git handler getter. */` (line 147) was left behind, now dangling directly above getExtensionHttpHandler, mislabeling that field.

- **Impact:** Cosmetic: misleading doc comment; no runtime effect.

- **Suggested fix:** Delete the orphaned comment on line 147.

- **Verifier evidence:** src/server/gateway.ts:147-149:
  147	  /** Dynamic in-process git handler getter. */
  148	  /** Dynamic in-process extension fetch handler getter. */
  149	  getExtensionHttpHandler?: () => ExtensionHttpHandler | null | undefined;

git diff HEAD confirms removal: `-  getGitHandler?: () => GitHttpHandler | null | undefined;` and `-      const gitHandler = this.deps.getGitHandler?.();`. Grep for `getGitHandler` in the current file returns no matches.

### P3-49 — Conflicted publish parks with no in-editor resolve path — only Abort is offered
- **Subsystem:** spectrolite panel + agentic-chat UI (git->vcs migration)  
- **Category:** incomplete-design  
- **Prior finding:** none (new-issue)  
- **Locations:** `workspace/panels/spectrolite/app/publishController.ts:101-125`, `workspace/panels/spectrolite/components/PublishBar.tsx:88-125`  
- **What:** PublishController.publish() does pull-main-then-publish: on a conflicted pull it sets `pending` and returns 'needs-resolve'. The docstring (publishController.ts:13-16) promises conflicts 'land in the panel's OWN head — resolvable with the normal editor conflict tooling'. But the only surfaced affordance on the PendingMergeBar is Abort (PublishBar.tsx:108-116) which calls abortMerge and discards the merge. There is no UI that opens the conflicted files, shows the conflict, or lets the user resolve-then-republish from the bar. The conflicted paths are merely listed as comma-joined text (PublishBar.tsx:118-122). Re-running Publish after manually editing is the implied path, but nothing guides the user there, and onHeadAdvance treats incoming merge content as a normal reconcile (no conflict markers/affordance wired for the merge case). The 'resolve a merge from the editor' capability the plan claims is effectively absent.

- **Impact:** When a publish conflicts (concurrent edits on main), the user's only one-click option is to throw away the merge. The promised in-editor conflict resolution is not actually reachable, so divergent publishes are hard/impossible to complete without external tooling.

- **Suggested fix:** Add a 'Resolve' affordance to PendingMergeBar that opens the conflicted vcsPaths in the editor (and surfaces collision suggestions for them), then re-enables Publish once resolved. At minimum make the conflicted file paths clickable to open them.

- **Verifier evidence:** publishController.ts:109-114 — `const pull = await this.vcs.merge("main"); if (pull.status === "conflicted") { const pending = await this.vcs.pendingMerge(); this.set({ pending }); return { status: "needs-resolve" }; }`. Docstring publishController.ts:13-16 — "any divergence conflicts in the panel's OWN head — resolvable with the normal editor conflict tooling". PublishBar.tsx:108-116 — the ONLY button in PendingMergeBar: `<Button ... onClick={() => void app.publish.abort()} data-testid="spectrolite-publish-abort"><Cross1Icon /> Abort</Button>`. PublishBar.tsx:118-122 — conflicts rendered as inert text: `{conflicts.map((c) => c.path).join(", ")}`. createApp.ts:160-182 — `pushCollisions`/`resolveSuggestion` exist but are fed only by docController co-edit collisions (docController.ts:278: `if (collisions.length > 0) { this.deps.onCollisions(collisions, this.vcsPath); }`), with no link to the publish pending-merge state.

---

## Refuted (checked and dismissed as false positives)

- **alreadyIngested dedup is compaction-fragile: a redelivered prompt whose recv entry was compacted out of `entries` re-opens a turn (AL-8 residual)** (agent-loop-pure) — The finding correctly observes that the in-package `alreadyIngested` fast-path (step.ts:421-426) scans `state.entries` and that compaction (step.ts:515-537 + fold.ts:270-276) replaces `entries` with `slice(-8)`, so an evicted recv id makes `alreadyIngested` return false. That part is accurate. But the load-bearing claim — that a channel redelivery then "takes the !openTurn branch and produces a fresh recv+turn.opened+message.started batch, spuriously re-opening a turn" / "re-prompt the model, re-execute tools" — is false, because compaction only rewrites the fold's in-memory `entries` projection; it never truncates the durable GAD lineage.
- **pump() reconciles in-memory loops with possibly-stale fold state, and reconcile can DELETE a still-valid outbox row** (agentic-do-driver) — The reviewer's mechanical reading of the code is accurate, but the harmful consequence does not arise in the current code under the system's own invariants.
- **Gap repair fetches only one 500-event page; events beyond the first page after a reconnect are silently skipped** (channel-do) — The finding's "silent transcript hole" rests on two posited preconditions, both of which are false in the actual code, so the single-page gap repair cannot drop events on the path the finding scopes itself to (gap <= MAX_GAP_SIZE).
- **Watchdog deletes executingMethods even when the timeout terminal was not accepted, allowing a redelivery to double-execute** (pubsub-client) — The reviewer correctly describes the watchdog's bookkeeping asymmetry: in rpc-client.ts the watchdog's `.then` only calls `rememberSubmittedMethodTransportCall` when `accepted` is true (line 1058), while its `.finally` unconditionally runs `executingMethods.delete` (line 1068). And `submitMethodResult` does return false when the channel's submitMethodResult resolves `{id: undefined}` for the 'missing' resolution (channel-do.ts:1197-1202 → rpc-client.ts:931). So after a rejected/missing terminal submit, the call is indeed removed from `executingMethods` without being added to `submittedMethodTransportCallIds`.\n\nHowever, the conclusion — that a redelivered `invocation.started` then re-enters `handleMethodCallExec` and double-executes — is wrong, because the reviewer overlooked the journaled-deadline guard at lines 1000-1008. That guard runs BEFORE `executingMethods.set` and BEFORE re-execution, and skips any call whose `deadlineAt - Date.now() <= 1_000`.\n\nKey facts that close the gap:\n1. The watchdog only exists for deadline-bound calls: it is armed inside `if (remainingMs !== null)` (line 1037), the exact same `remainingMs` the deadline guard tests (lines 999-1000).\n2. `deadlineAt` is an absolute journaled timestamp copied from `transport.deadlineAt` (invocationCallFromAgenticEvent, lines 496-498), so a redelivery of the same invocation carries the identical `deadlineAt`.\n3. The watchdog is `setTimeout(..., remainingMs)` where `remainingMs = event.deadlineAt - Date.now()` at original delivery (lines 998-999); setTimeout never fires early, so when the watchdog body runs (and deletes `executingMethods`), wall-clock is already ≈/past `event.deadlineAt`, i.e. a redelivery now computes `remainingMs <= 0 <= 1_000` and is skipped at line 1007.\n\nThus the two windows are both covered: BEFORE the watchdog fires, the call is still in `executingMethods` so the dedup check at 957-960 skips the redelivery; AT/AFTER the watchdog fires, the deadline guard at 1000-1008 skips it. For a redelivery to bypass the deadline guard it would need to arrive >1s before `deadlineAt`, but at that time the watchdog has not yet fired, so `executingMethods` still holds the call. There is no window in which a redelivery both passes the deadline guard and finds the call absent from both sets. The double-execution the finding targets is not reachable. Lowered to P3: the bookkeeping asymmetry is real and slightly fragile (relying on the deadline guard as the backstop rather than remembering the call), but it does not produce the claimed integrity bug.
- **Provider panel does not re-execute pending method calls redelivered as replay after a reload, stranding deadline-less approvals** (pubsub-client) — The finding's two cited facts are individually accurate but its causal mechanism is wrong, and the actual recovery path it overlooks defeats the claimed wedge.
- **CV-2 fallback still absent: getBuild/bindRuntimeImage throw "Unknown vcs ref" for a ctx: ref whose head is null** (buildv2) — The reviewer correctly read the throw sites, but the asserted impact (a worker/DO scoped to a freshly-created context fails to bind) is not reachable through any actual caller, so this is not a live P1.

---

## Verified-clean (prior fixes confirmed genuinely correct)

- **gadVcs store + CAS materialization:** CV-3 (atomic CAS materialization) is genuinely fixed and correct in current code: materializeFileList (store.ts:534-566) writes via writeMaterializedFile (568-592) which always goes temp-file→fsp.rename (atomic), and the existing-file fast path now validates `existing.isFile() && existing.size === s
- **gadVcs merge engine + diff3:** MG-1 VERIFIED CORRECT: I executed the exact repro diff3Merge('a\
- **gadVcs WorkspaceVcs + gitBridge:** Verified-correct claimed fixes in current code: MG-2 — mergeHeads DOES getPendingMerge first and refuses when one is parked (workspaceVcs.ts:643-651); the conflicted path records pending with materialized:false then flips to true after materializeState (lines 771-781); abortMerge restores the TRUE p
- **gad-store DO (unified log core, schema v16):** VERIFIED CORRECT prior fixes: (1) AL-3 — the envelope hash preimage is now unambiguous and length-prefixed. logEnvelopeHashPreimage (workspace/packages/agentic-protocol/src/log-envelope.ts:85-94) emits `gadlog:2\
- **agentic-protocol (envelopes, hash, stored-values, reducers):** VERIFIED CLAIMED FIXES (genuinely correct in current code):
- **agent-loop pure package (fold / step / effects):** Verified-correct claimed fixes: AL-6 (overlayInputConfig in state.ts:62-77 preserves only `roster` as fold-owned and overlays all input settings; the config.changed fold at fold.ts:322-327 merges the patch over config — config overlay is genuinely correct). AL-1 fold-read shape (system.compaction_re
- **agentic-do driver + outbox + executors:** Verified prior-fix claims that are GENUINELY correct in current code:
- **agentic-do vessel + worker base + channel client:** Verified-correct claimed fixes: (CAP-2) ask_user IS registered in the vessel tool registry via AgentWorkerBase.getLoopTools -> createAskUserTool (agent-worker-base.ts:143,162), its execute throws by design, and askUserPolicy (in defaultPolicies, policies/index.ts:367) rewrites the ask_user invocatio
- **pubsub channel DO rewrite + channel-policies:** Verified-correct claimed fixes (genuinely present and correct in current code): CH-1 — delivery/emit chains are keyed by deliveryKey(channelId, participantId) = `${channelId}\\u0000${participantId}` in broadcast.ts:33-35, and cleanupDeliveryChain uses the same key; module-scope maps are no longer cr
- **pubsub rpc-client + protocol/tool types:** Verified CH-3 deadline plumbing end-to-end and found it genuinely correct: the executing client derives its abort budget from `event.deadlineAt` (rpc-client.ts:998-999) with NO hardcoded 120s; a deadline far in the future yields a correspondingly long setTimeout, so methods legitimately longer than 
- **buildV2 (state trigger, refs, buildSource, index, builder):** Verified-correct claimed fixes in this scope: (CV-1) State-graph builds resolve the entry path against the materialization root, not workspaceRoot: prepareBuildEnv now uses sourcePathForNode(node, sourceRoot)=path.join(sourceRoot, node.relativePath) then resolveEntryPoint (builder.ts:1711), and the 
- **vcs RPC service + CLI + schemas:** Verified claimed fixes that are genuinely CORRECT in current code:
- **runtime wiring (context folders, fsService, vcsClient, durable-base):** VERIFIED FIXES (genuinely correct in current code):
- **approvals overhaul (bootstrap + main-advance) [NEW area]:** VERIFIED CORRECT FIXES: (1) IN-5 (who may advance main): the null-context main fallthrough is closed — resolveWriteHead (vcsService.ts:81-86) now THROWS for entity callers with no context instead of falling through to main. Entity callers (panel/app/worker/do/extension) can only write their own ctx 
- **web-search harness tools + tool-vcs:** Verified-correct claimed fixes: (1) CAP-3 — web tools ARE reachable: createWebTools is consumed in workspace/packages/agentic-do/src/agent-worker-base.ts:144 inside getLoopTools, wired with rpc.call and a hasCredentialForOrigin probe over credentials.resolveCredential. Not an unwired tool. (2) The k
- **server boot/index + workerdManager + gateway + headless-host:** Verified-correct prior fixes / claims: IN-6 (boot-deadlock from freshness:\"serve\"): all hot-path code loaders now use getBuildByKey (sync, disk-backed via buildStore.get) plus a warming 503 fallback (RuntimeImageWarmingError) wired through gateway.ts and the workerd/UniversalDO host code (503 + Re
- **panel HTTP serving + shell session:** Verified genuinely-correct fixes in scope: (1) IN-4 cross-CONTEXT leak via findResourceInAnySourceBuild is genuinely closed — that method is fully removed (no refs remain in panelHttpServer.ts) and sub-resource lookup is now an exact `servingCache.get(buildCacheKey(source, ref))`; combined with cont
- **spectrolite panel + agentic-chat UI (git->vcs migration):** VERIFIED CLAIMED FIXES (genuinely correct): (1) PF-4 — useChannelMessages.ts correctly avoids a full rebuild per durable event during replay: durable agentic/credential events in `phase === 'replay'` set `replayDirty=true` and schedule a single coalesced rebuild via a 0ms timer (scheduleReplayRebuil
- **vessel workers (gmail/silent/agent-worker/hello):** Verified genuinely-correct items: (1) CAP-2/CAP-3 for the default AiChatWorker path: ask_user and web tools ARE present in AgentWorkerBase.getLoopTools (agent-worker-base.ts:143-158), and ask_user is rewired by askUserPolicy in defaultPolicies (agent-loop/policies/index.ts:171), so the default chat 
- **cross-cutting: dangling references to deleted modules:** Verified-clean (genuinely correct deletions, no danglers): (1) NO live import of `@workspace/git-ui` exists anywhere in code (only mentions are in docs/unified-log-review-findings.md and the workflow prompt) — package fully orphaned/removed as claimed. (2) No package.json depends on `@workspace/git-
