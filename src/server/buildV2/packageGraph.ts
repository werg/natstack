/**
 * Package Graph — DAG discovery from workspace package.json files.
 *
 * Scans workspace/packages/, workspace/panels/, workspace/about/
 * and builds an adjacency-list DAG of internal dependencies. Detects cycles,
 * produces topological ordering.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  /** Absolute path to the unit directory */
  path: string;
  /** Workspace-relative path (e.g., "packages/core", "panels/chat") */
  relativePath: string;
  /** Package name from package.json (e.g., "@workspace/core") */
  name: string;
  /** Unit kind */
  kind: "package" | "panel" | "about";
  /** All dependencies from package.json (name → version) */
  dependencies: Record<string, string>;
  /** Resolved internal dependency names */
  internalDeps: string[];
  /** Internal dependency ref spec (branch/ref/commit) keyed by dep name */
  internalDepRefs: Record<string, InternalDepRef>;
  /** Content hash (populated by effectiveVersion) */
  contentHash: string;
  /** natstack manifest from package.json */
  manifest: PackageManifest;
}

export interface InternalDepRef {
  /** Original dependency spec string from package.json */
  raw: string;
  /** How this dependency ref should be resolved */
  mode: "default" | "branch" | "ref" | "commit";
  /** Branch name (when mode === "branch") */
  branch?: string;
  /** Full git ref (when mode === "ref") */
  ref?: string;
  /** Commit SHA (when mode === "commit") */
  commit?: string;
}

export interface PackageManifest {
  type?: "app";
  title?: string;
  description?: string;
  entry?: string;
  shell?: boolean;
  hiddenInLauncher?: boolean;
  sourcemap?: boolean;
  externals?: Record<string, string>;
  exposeModules?: string[];
  dedupeModules?: string[];
}

export class PackageGraph {
  /** name → GraphNode */
  private nodes = new Map<string, GraphNode>();
  /** Topologically sorted node names (leaves first) */
  private topoOrder: string[] = [];

  addNode(node: GraphNode): void {
    this.nodes.set(node.name, node);
  }

  get(name: string): GraphNode {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Unknown package: ${name}`);
    return node;
  }

  tryGet(name: string): GraphNode | undefined {
    return this.nodes.get(name);
  }

  has(name: string): boolean {
    return this.nodes.has(name);
  }

  isInternal(name: string): boolean {
    return this.nodes.has(name);
  }

  allNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** Returns nodes in topological order (leaves first, dependents last). */
  topologicalOrder(): GraphNode[] {
    return this.topoOrder.map((name) => this.get(name));
  }

  /**
   * Compute topological ordering. Throws on cycles.
   */
  computeTopologicalOrder(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>(); // cycle detection
    const order: string[] = [];

    const visit = (name: string, stack: string[]) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
      }

      visiting.add(name);
      stack.push(name);

      const node = this.get(name);
      for (const dep of node.internalDeps) {
        visit(dep, stack);
      }

      visiting.delete(name);
      stack.pop();
      visited.add(name);
      order.push(name);
    };

    for (const name of this.nodes.keys()) {
      visit(name, []);
    }

    this.topoOrder = order;
  }

  /**
   * Get all nodes that transitively depend on the given node (reverse deps).
   * Useful for knowing what needs rebuilding when a package changes.
   */
  getReverseDeps(name: string): Set<string> {
    const result = new Set<string>();
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const node of this.nodes.values()) {
        if (node.internalDeps.includes(current) && !result.has(node.name)) {
          result.add(node.name);
          queue.push(node.name);
        }
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const WORKSPACE_SCOPES = ["@workspace/", "@workspace-panels/", "@workspace-about/"];

function isInternalDep(name: string): boolean {
  return WORKSPACE_SCOPES.some((scope) => name.startsWith(scope));
}

function parseInternalDepRef(rawSpec: string): InternalDepRef {
  const raw = (rawSpec ?? "").trim();
  const normalized = raw.toLowerCase();

  // Default workspace-local semantics.
  if (!raw || raw === "*" || normalized === "workspace:*" || normalized === "workspace:") {
    return { raw: raw || "*", mode: "default" };
  }

  // Common shorthand: workspace:<branch>
  if (normalized.startsWith("workspace:")) {
    const rest = raw.slice("workspace:".length).trim();
    if (!rest || rest === "*") return { raw, mode: "default" };

    if (rest.startsWith("commit:")) {
      const commit = rest.slice("commit:".length).trim();
      return { raw, mode: "commit", commit };
    }
    if (rest.startsWith("ref:")) {
      const ref = rest.slice("ref:".length).trim();
      return { raw, mode: "ref", ref };
    }
    if (rest.startsWith("branch:")) {
      const branch = rest.slice("branch:".length).trim();
      return { raw, mode: "branch", branch };
    }
    if (/^[0-9a-f]{7,40}$/i.test(rest)) {
      return { raw, mode: "commit", commit: rest };
    }
    if (rest.startsWith("refs/")) {
      return { raw, mode: "ref", ref: rest };
    }
    return { raw, mode: "branch", branch: rest };
  }

  // Fallbacks for non-workspace-prefixed internal dep specs.
  if (/^[0-9a-f]{7,40}$/i.test(raw)) {
    return { raw, mode: "commit", commit: raw };
  }
  if (raw.startsWith("refs/")) {
    return { raw, mode: "ref", ref: raw };
  }
  return { raw, mode: "default" };
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  natstack?: PackageManifest;
  exports?: Record<string, unknown>;
  main?: string;
}

function readPackageJson(dir: string): PackageJson | null {
  const p = path.join(dir, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PackageJson;
  } catch {
    return null;
  }
}

function scanDirectory(
  dir: string,
  workspaceRoot: string,
  kind: GraphNode["kind"],
): GraphNode[] {
  if (!fs.existsSync(dir)) return [];
  const nodes: GraphNode[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const unitDir = path.join(dir, entry.name);
    const pkg = readPackageJson(unitDir);
    if (!pkg?.name) continue;

    const allDeps = { ...pkg.peerDependencies, ...pkg.dependencies };
    const internalDeps: string[] = [];
    const internalDepRefs: Record<string, InternalDepRef> = {};

    for (const [depName, depSpec] of Object.entries(allDeps)) {
      if (isInternalDep(depName)) {
        internalDeps.push(depName);
        internalDepRefs[depName] = parseInternalDepRef(depSpec);
      }
    }

    nodes.push({
      path: unitDir,
      relativePath: path.relative(workspaceRoot, unitDir).replace(/\\/g, "/"),
      name: pkg.name,
      kind,
      dependencies: allDeps,
      internalDeps,
      internalDepRefs,
      contentHash: "", // populated later
      manifest: pkg.natstack ?? {},
    });
  }

  return nodes;
}

/**
 * Discover all buildable units in the workspace and build the package graph.
 */
export function discoverPackageGraph(workspaceRoot: string): PackageGraph {
  const graph = new PackageGraph();

  const packagesDir = path.join(workspaceRoot, "packages");
  const panelsDir = path.join(workspaceRoot, "panels");
  const aboutDir = path.join(workspaceRoot, "about");

  for (const node of scanDirectory(packagesDir, workspaceRoot, "package")) {
    graph.addNode(node);
  }
  for (const node of scanDirectory(panelsDir, workspaceRoot, "panel")) {
    graph.addNode(node);
  }
  for (const node of scanDirectory(aboutDir, workspaceRoot, "about")) {
    graph.addNode(node);
  }

  // Validate: all internal deps must exist in the graph
  for (const node of graph.allNodes()) {
    for (const dep of node.internalDeps) {
      if (!graph.has(dep)) {
        console.warn(
          `[PackageGraph] ${node.name} depends on ${dep} which is not in the workspace`
        );
        // Remove missing deps to avoid topo sort errors
        node.internalDeps = node.internalDeps.filter((d) => d !== dep);
      }
    }
  }

  graph.computeTopologicalOrder();
  return graph;
}
