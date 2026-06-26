/**
 * Worktree content addressing — the ONE implementation of GAD manifest and
 * state hashing, shared by the gad-store DO (authoritative storage) and the
 * server-side vcs (local-first hashing during bootstrap, before the DO is
 * reachable). Content addresses are pure functions of the tree; computing
 * them locally and in the DO MUST agree byte-for-byte — gadStore.test.ts
 * cross-checks this.
 *
 * Pure JS sync sha256: workerd has no synchronous crypto, and these hashes
 * are needed inside synchronous SQL transactions.
 */

import { canonicalJson } from "./canonical-json.js";

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export function sha256HexSyncText(text: string): string {
  const data = new TextEncoder().encode(text);
  const bitLength = data.length * 8;
  const totalLength = ((data.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(totalLength);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(totalLength - 8, high, false);
  view.setUint32(totalLength - 4, low, false);
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr32(e!, 6) ^ rotr32(e!, 11) ^ rotr32(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr32(a!, 2) ^ rotr32(a!, 13) ^ rotr32(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function stableSha256Hex(value: unknown): string {
  return sha256HexSyncText(canonicalJson(value));
}

// ---------------------------------------------------------------------------
// Manifest / worktree-state addressing
// ---------------------------------------------------------------------------

export type ManifestHashEntry =
  | { name: string; kind: "file"; contentHash: string; mode: number }
  | { name: string; kind: "dir"; childHash: string };

export function manifestHashForEntries(entries: ManifestHashEntry[]): string {
  // Codepoint compare, NOT localeCompare: this hash must agree byte-for-byte
  // across node and workerd, and localeCompare is ICU/locale-dependent.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `manifest:${stableSha256Hex({ kind: "dir", entries: sorted })}`;
}

export function stateHashForRoot(rootHash: string): string {
  return `state:${stableSha256Hex({ manifestRootHash: rootHash })}`;
}

export const EMPTY_MANIFEST_HASH = manifestHashForEntries([]);
export const EMPTY_STATE_HASH = stateHashForRoot(EMPTY_MANIFEST_HASH);

export interface WorktreeHashFile {
  /** Worktree-relative posix path. */
  path: string;
  /** Plain hex sha256 of the file bytes (the blobstore CAS digest). */
  contentHash: string;
  /** Git-style mode (33188 regular, 33261 executable). */
  mode: number;
}

export interface WorktreeManifest {
  rootHash: string;
  stateHash: string;
  /**
   * Content address for a path within the tree: a dir resolves to its
   * manifest hash, a file to its content hash, an absent path to null.
   */
  subtreeHash(path: string): string | null;
}

/**
 * Compute the manifest tree (with structural sharing semantics identical to
 * the gad-store DO's `createManifestTree`) purely in memory.
 */
export function buildWorktreeManifest(files: WorktreeHashFile[]): WorktreeManifest {
  interface DirNode {
    dirs: Map<string, DirNode>;
    files: Map<string, { contentHash: string; mode: number }>;
    hash?: string;
  }
  const root: DirNode = { dirs: new Map(), files: new Map() };
  for (const file of files) {
    const segments = file.path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (!child) {
        child = { dirs: new Map(), files: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, {
      contentHash: file.contentHash,
      mode: file.mode,
    });
  }
  const build = (node: DirNode): string => {
    const entries: ManifestHashEntry[] = [];
    for (const [name, child] of node.dirs) {
      entries.push({ name, kind: "dir", childHash: build(child) });
    }
    for (const [name, file] of node.files) {
      entries.push({ name, kind: "file", contentHash: file.contentHash, mode: file.mode });
    }
    const hash = manifestHashForEntries(entries);
    node.hash = hash;
    return hash;
  };
  const rootHash = files.length === 0 ? EMPTY_MANIFEST_HASH : build(root);
  const stateHash = stateHashForRoot(rootHash);

  const subtreeHash = (path: string): string | null => {
    if (!path) return rootHash;
    const segments = path.split("/");
    let node: DirNode | undefined = root;
    for (let index = 0; index < segments.length; index += 1) {
      if (!node) return null;
      const segment = segments[index]!;
      if (index === segments.length - 1) {
        const dir: DirNode | undefined = node.dirs.get(segment);
        if (dir) return dir.hash ?? null;
        const file = node.files.get(segment);
        return file ? file.contentHash : null;
      }
      node = node.dirs.get(segment);
    }
    return null;
  };

  return { rootHash, stateHash, subtreeHash };
}
