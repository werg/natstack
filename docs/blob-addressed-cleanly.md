GAD currently uses blob-addressed content, but the generic blob store is not yet a full tree store.

  Right now, file bytes are content-addressed blobs, but the meaningful worktree shape is still GAD-owned metadata: manifests, file versions, manifest nodes, state hashes. The build system also still works from materialized directories. So GAD is too
  central: it owns both version semantics and too much of the content/tree representation.

  The cleaner architecture would be:

  Target Shape

  Server owns:

  - protected refs, especially repo -> main
  - approval-gated ref advancement
  - disk projection/materialization when needed
  - build orchestration for a requested tree hash
  - caller identity and capability grants

  Generic content store owns:

  - blobs
  - immutable trees
  - tree diffs
  - tree materialization
  - path reads/listing
  - GC roots

  GAD owns:

  - userland VCS semantics
  - commit/merge/provenance/history
  - proposing new tree hashes
  - requesting main advancement through the server API

  Build system owns:

  - “build this unit/subtree at this tree hash”
  - cache keys based on content hashes
  - no dependency on GAD internals

  So the server would not be “the GAD server.” It would maintain protected refs and accept build/projection requests for content-addressed trees.

  Blob Store Extension

  I would promote the blob store into a small generic content store.

  Add first-class immutable objects:

  BlobObject = sha256(file bytes)

  TreeObject = hash(canonical entries)
  entry = {
    name,
    type: "file" | "tree",
    hash,
    size?,
    executable?,
  }

  Then expose APIs like:

  putBlob(bytes) -> blobHash
  getBlob(blobHash) -> stream

  putTree(entries) -> treeHash
  getTree(treeHash) -> entries

  readFile(treeHash, path) -> blobHash | bytes
  listTree(treeHash, prefix?) -> entries
  diffTrees(baseTree, nextTree) -> changedPaths
  materializeTree(treeHash, outDir, options)

  The content store should not know about GAD commits, branches, merges, authorship, or approval semantics. It should only know immutable content.

  Tree metadata could be stored as canonical JSON blobs, or in indexed tables for performance, but the abstraction should be generic: a tree hash represents a filesystem tree.

  Ref Model

  Then the server maintains refs:

  repo/main -> treeHash
  repo/context/<id> -> treeHash // maybe, depending on whether contexts remain server-visible

  Main advancement becomes a compare-and-swap operation:

  advanceRef({
    repo,
    ref: "main",
    expectedOldTree,
    nextTree,
    caller,
    reason,
  })

  The server computes the diff itself from expectedOldTree to nextTree, then gates it.

  For ordinary repos, that uses the general workspace-repo-write approval path.

  For the meta repo, the server additionally derives semantic unit changes from the diff/tree contents and shows the special meta approval prompt.

  The caller should not be trusted to supply the changed paths. It can supply a proposed summary, but the server/content store should compute the authoritative diff.

  Build Model

  Builds should become:

  requestBuild({
    repo,
    treeHash,
    unitPath,
    target,
  })

  The builder can still materialize to a temp directory initially, because most JS tooling expects files. The important architectural change is that the build source is a tree hash, not “whatever GAD says this state contains.”

  Later, we can optimize with virtual reads, partial materialization, or package-level snapshots. But the first win is decoupling: build works from the content store, not GAD.

  Migration Plan

  1. Extract a generic ContentStore/TreeStore beside the current blob store.
     Reuse the existing file blob hashes and canonical worktree hashing where possible.

  2. Move tree/list/diff/materialize operations out of GAD into this store.
     GAD can still call them, but no longer owns them.

  3. Change build source resolution to consume treeHash.
     Keep filesystem materialization as an implementation detail.

  4. Change GAD state outputs to point at content-store tree hashes.
     GAD keeps commits/history/merge state, but not private worktree manifests as the system source of truth.

  5. Introduce protected server refs.
     main is just a protected ref pointing to a tree hash.

  6. Gate all main ref advances in one path.
     General repos use normal repo-write approval. Meta repo gets the richer semantic prompt.

  7. Shrink WorkspaceVcs.
     It should stop being the privileged mega-owner and eventually become either a thin projection service or disappear behind ContentStore + RefService + BuildService.

  Caveats

  We need atomic ref updates, durable refs, object validation, GC roots, and strict path normalization. Userland should not be able to claim a tree hash unless the content store has all referenced objects and the tree is valid.


