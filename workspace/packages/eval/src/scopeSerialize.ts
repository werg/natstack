/**
 * scopeSerialize — Recursive per-property serializer for REPL scope.
 *
 * Keeps data leaves, drops function leaves, reports full dotted paths
 * of dropped values. Handles type-tagged values (Date, Map, Set, RegExp),
 * circular references, and max depth.
 */

const MAX_DEPTH = 20;

export interface SerializedScope {
  /** JSON string of serializable data */
  json: string;
  /** Top-level keys that were fully serialized */
  serializedKeys: string[];
  /** Paths that were dropped, with reasons */
  droppedPaths: Array<{ path: string; reason: string }>;
  /** Top-level keys that were only partially serialized */
  partialKeys: string[];
}

// ---------------------------------------------------------------------------
// Type-tagged envelope for round-trip fidelity
// ---------------------------------------------------------------------------

interface TypeTagged {
  __t: string;
  v: unknown;
}

function isTypeTagged(val: unknown): val is TypeTagged {
  return (
    typeof val === "object" &&
    val !== null &&
    "__t" in val &&
    typeof (val as TypeTagged).__t === "string"
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type DroppedEntry = { path: string; reason: string };

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function serializeValue(
  val: unknown,
  path: string,
  dropped: DroppedEntry[],
  seen: Set<unknown>,
  depth: number,
): unknown {
  // Max depth
  if (depth > MAX_DEPTH) {
    dropped.push({ path, reason: "max depth exceeded" });
    return undefined;
  }

  // Primitives
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;
  if (t === "bigint") return { __t: "BigInt", v: val.toString() };

  // Drop functions and symbols
  if (t === "function") {
    dropped.push({ path, reason: "function" });
    return undefined;
  }
  if (t === "symbol") {
    dropped.push({ path, reason: "symbol" });
    return undefined;
  }

  // Circular reference check
  if (typeof val === "object" && val !== null) {
    if (seen.has(val)) {
      dropped.push({ path, reason: "circular" });
      return undefined;
    }
    seen.add(val);
  }

  try {
    // Type-tagged values
    if (val instanceof Date) {
      return { __t: "Date", v: val.toISOString() };
    }
    if (val instanceof RegExp) {
      return { __t: "RegExp", v: { source: val.source, flags: val.flags } };
    }
    if (val instanceof Map) {
      const entries: [unknown, unknown][] = [];
      let i = 0;
      for (const [k, v] of val) {
        const kSer = serializeValue(k, `${path}[Map key ${i}]`, dropped, seen, depth + 1);
        const vSer = serializeValue(v, `${path}[Map value ${i}]`, dropped, seen, depth + 1);
        entries.push([kSer, vSer]);
        i++;
      }
      return { __t: "Map", v: entries };
    }
    if (val instanceof Set) {
      const items: unknown[] = [];
      let i = 0;
      for (const item of val) {
        const ser = serializeValue(item, `${path}[Set ${i}]`, dropped, seen, depth + 1);
        items.push(ser);
        i++;
      }
      return { __t: "Set", v: items };
    }

    // WeakMap, WeakSet — drop
    if (val instanceof WeakMap || val instanceof WeakSet) {
      dropped.push({ path, reason: val.constructor.name });
      return undefined;
    }
    // WeakRef — may not exist in all targets, check by constructor name
    if (val.constructor?.name === "WeakRef") {
      dropped.push({ path, reason: "WeakRef" });
      return undefined;
    }

    // Arrays
    if (Array.isArray(val)) {
      const result: unknown[] = [];
      for (let i = 0; i < val.length; i++) {
        const elemPath = `${path}[${i}]`;
        const ser = serializeValue(val[i], elemPath, dropped, seen, depth + 1);
        result.push(ser !== undefined ? ser : null);
      }
      return result;
    }

    // Plain objects
    if (isPlainObject(val)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(val)) {
        const childPath = path ? `${path}.${key}` : key;
        const ser = serializeValue(val[key], childPath, dropped, seen, depth + 1);
        if (ser !== undefined) {
          result[key] = ser;
        }
      }
      return result;
    }

    // Class instances — drop (prototype not Object.prototype/null)
    dropped.push({ path, reason: `class instance (${val.constructor?.name ?? "unknown"})` });
    return undefined;
  } finally {
    if (typeof val === "object" && val !== null) {
      seen.delete(val);
    }
  }
}

export function serializeScope(scope: Map<string, unknown>): SerializedScope {
  const dropped: DroppedEntry[] = [];
  const serialized: Record<string, unknown> = {};

  for (const [key, value] of scope) {
    const ser = serializeValue(value, key, dropped, new Set(), 0);
    if (ser !== undefined) {
      serialized[key] = ser;
    }
  }

  // Determine which top-level keys are fully vs partially serialized
  const serializedKeys: string[] = [];
  const partialKeys: string[] = [];

  for (const key of scope.keys()) {
    const hasDrops = dropped.some(
      (d) => d.path === key || d.path.startsWith(key + ".") || d.path.startsWith(key + "["),
    );
    if (key in serialized) {
      if (hasDrops) {
        partialKeys.push(key);
      } else {
        serializedKeys.push(key);
      }
    }
    // If key not in serialized at all, it was fully dropped — already in droppedPaths
  }

  return {
    json: JSON.stringify(serialized),
    serializedKeys,
    droppedPaths: dropped,
    partialKeys,
  };
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function deserializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  const t = typeof val;
  if (t === "string" || t === "number" || t === "boolean") return val;

  if (Array.isArray(val)) {
    return val.map(deserializeValue);
  }

  if (typeof val === "object" && val !== null) {
    // Type-tagged values
    if (isTypeTagged(val)) {
      switch (val.__t) {
        case "Date":
          return new Date(val.v as string);
        case "RegExp": {
          const rv = val.v as { source: string; flags: string };
          return new RegExp(rv.source, rv.flags);
        }
        case "Map": {
          const entries = val.v as [unknown, unknown][];
          return new Map(entries.map(([k, v]) => [deserializeValue(k), deserializeValue(v)]));
        }
        case "Set": {
          const items = val.v as unknown[];
          return new Set(items.map(deserializeValue));
        }
        case "BigInt":
          return BigInt(val.v as string);
      }
    }

    // Plain object
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(val)) {
      result[key] = deserializeValue(child);
    }
    return result;
  }

  return val;
}

export function deserializeScope(json: string): Map<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed)) {
    map.set(key, deserializeValue(value));
  }
  return map;
}
