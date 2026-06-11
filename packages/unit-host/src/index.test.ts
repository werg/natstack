import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  UnitHost,
  UnitRegistry,
  UnitTrustResolver,
  authorizeUnitSourcePush,
  canonicalUnitBuildIdentity,
  collectTransitiveUnitDependencyEvs,
  createPendingUnitRegistryEntry,
  createUnitBatchEntryBase,
  createUnitBuildIdentity,
  findUnitGraphNode,
  normalizeUnitRepoPath,
  requestUnitBatchApproval,
  unitBuildIdentityFromRegistryEntry,
  unitPushSessionGrantKey,
  unitWorkspaceLogRecord,
  unitWorkspaceStatus,
  type UnitApprovalCoordinator,
  type UnitDeclaration,
  type UnitBuildIdentity,
  type UnitGraphNode,
  type UnitRegistryEntryBase,
} from "./index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-unit-registry-"));
  roots.push(root);
  return root;
}

function entry(overrides: Partial<UnitRegistryEntryBase> = {}): UnitRegistryEntryBase {
  return {
    unitKind: "extension",
    name: "@workspace-extensions/a",
    version: "1.0.0",
    source: { kind: "internal-git", repo: "extensions/a", ref: "main" },
    installedAt: 1,
    activeEv: null,
    activeSha: null,
    activeBundleKey: null,
    activeDependencyEvs: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    status: "pending-approval",
    lastError: null,
    ...overrides,
  };
}

describe("UnitRegistry", () => {
  it("persists entries by unit kind under the shared units path", () => {
    const root = tempRoot();
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });
    registry.upsert(entry({ activeDependencyEvs: { "@workspace/runtime": "ev" } }));

    const reloaded = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });

    expect(reloaded.get("@workspace-extensions/a")).toMatchObject({
      unitKind: "extension",
      activeDependencyEvs: { "@workspace/runtime": "ev" },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "units", "extension", "registry.json"), "utf8")),
    ).toMatchObject({ unitKind: "extension" });
  });

  it("rejects storing an entry in the wrong unit registry", () => {
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: tempRoot(),
      unitKind: "extension",
    });

    expect(() => registry.upsert(entry({ unitKind: "app" }))).toThrow(/Cannot store app/);
  });

  it("builds pending registry entries with shared install-state defaults", () => {
    expect(createPendingUnitRegistryEntry({
      unitKind: "app",
      name: "@workspace-apps/shell",
      version: "1.0.0",
      sourceRepo: "workspace/apps/shell",
      ref: "main",
      building: true,
      installedAt: 10,
    })).toMatchObject({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
      installedAt: 10,
      activeEv: null,
      activeBundleKey: null,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "building",
      lastError: null,
    });
  });

  it("builds shared batch approval entry bases with normalized source identity", () => {
    expect(createUnitBatchEntryBase({
      unitKind: "app",
      name: "@workspace-apps/shell",
      displayName: "Workspace Shell",
      version: "1.0.0",
      sourceRepo: "/workspace/apps/shell.git",
      ref: "main",
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
    })).toEqual({
      unitKind: "app",
      unitName: "@workspace-apps/shell",
      displayName: "Workspace Shell",
      version: "1.0.0",
      source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
      ev: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      commit: null,
    });
  });

  it("builds shared unit identities with normalized source and sorted capabilities", () => {
    expect(createUnitBuildIdentity({
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "/workspace/apps/shell.git",
      ref: "main",
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      capabilities: ["z", "a"],
    })).toEqual({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      capabilities: ["a", "z"],
    });
  });

  it("builds registry-entry identities through the shared identity normalizer", () => {
    expect(unitBuildIdentityFromRegistryEntry(entry({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "internal-git", repo: "/workspace/apps/shell.git", ref: "main" },
      activeEv: "ev-app",
      activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
      activeExternalDeps: { react: "19.0.0" },
    }), ["z", "a"])).toEqual({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      capabilities: ["a", "z"],
    });
  });

  it("collects transitive dependency effective versions once", () => {
    const nodes = [
      { name: "app", relativePath: "apps/app", internalDeps: ["pkg-a", "pkg-b"] },
      { name: "pkg-a", relativePath: "packages/a", internalDeps: ["pkg-c"] },
      { name: "pkg-b", relativePath: "packages/b", internalDeps: ["pkg-c", "missing"] },
      { name: "pkg-c", relativePath: "packages/c", internalDeps: [] },
    ];
    const lookups: string[] = [];

    expect(
      collectTransitiveUnitDependencyEvs(nodes, nodes[0]!, (name) => {
        lookups.push(name);
        return name === "missing" ? null : `ev-${name}`;
      }),
    ).toEqual({
      "pkg-a": "ev-pkg-a",
      "pkg-b": "ev-pkg-b",
      "pkg-c": "ev-pkg-c",
    });
    expect(lookups).toEqual(["pkg-a", "pkg-c", "pkg-b", "missing"]);
  });

  it("finds unit graph nodes by package name or normalized repo path", () => {
    const descriptor = {
      buildKind: "app" as const,
      approvalFraming: { unitLabel: "app" },
    };
    const nodes = [
      { name: "@workspace-apps/shell", kind: "app", relativePath: "apps/shell" },
      { name: "@workspace-extensions/rn", kind: "extension", relativePath: "extensions/rn" },
    ];

    expect(findUnitGraphNode(nodes, descriptor, "@workspace-apps/shell")).toBe(nodes[0]);
    expect(findUnitGraphNode(nodes, descriptor, "workspace/apps/shell.git")).toBe(nodes[0]);
    expect(() => findUnitGraphNode(nodes, descriptor, "@workspace-extensions/rn")).toThrow(/Unknown app unit/);
  });
});

describe("workspace unit summaries", () => {
  it("maps registry entries to shared workspace status rows", () => {
    expect(unitWorkspaceStatus("extension", entry({
      activeEv: "ev",
      activeBundleKey: "bundle",
      activeRuntimeDepsKey: "runtime",
      status: "running",
    }), {
      source: "extensions/display",
      displayName: "Display Name",
    })).toEqual({
      name: "@workspace-extensions/a",
      kind: "extension",
      source: "extensions/display",
      displayName: "Display Name",
      status: "running",
      version: "1.0.0",
      ev: "ev",
      activeEv: "ev",
      activeBundleKey: "bundle",
      activeRuntimeDepsKey: "runtime",
      lastError: null,
    });
  });

  it("maps registry entries to shared fallback log rows", () => {
    expect(unitWorkspaceLogRecord("app", "workspace-1", entry({
      unitKind: "app",
      name: "@workspace-apps/shell",
      status: "error",
      lastError: "boom",
    }))).toEqual({
      workspaceId: "workspace-1",
      unitName: "@workspace-apps/shell",
      kind: "app",
      timestamp: 1,
      level: "error",
      message: "boom",
    });
  });
});

describe("UnitTrustResolver", () => {
  function identity(overrides: Partial<UnitBuildIdentity<"extension">> = {}): UnitBuildIdentity<"extension"> {
    return {
      unitKind: "extension",
      name: "@workspace-extensions/a",
      source: { kind: "internal-git", repo: "extensions/a", ref: "main" },
      effectiveVersion: "ev",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { leftpad: "1.0.0" },
      ...overrides,
    };
  }

  it("canonicalizes build identities with sorted object keys", () => {
    const first = identity({
      dependencyEvs: { b: "2", a: "1" },
      externalDeps: { z: "26", c: "3" },
    });
    const second = identity({
      externalDeps: { c: "3", z: "26" },
      dependencyEvs: { a: "1", b: "2" },
    });

    expect(canonicalUnitBuildIdentity(first)).toBe(canonicalUnitBuildIdentity(second));
  });

  it("returns user-approved only for an active registry entry matching the candidate identity", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity();

    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("user-approved");
    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev-old",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("needs-approval");
    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: null,
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "pending-approval",
      }),
    }).decision).toBe("needs-approval");
  });

  it("does not reuse approval when the candidate identity is incomplete", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity({ effectiveVersion: null });

    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("needs-approval");
  });

  it("does not reuse approval across capability identity drift", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>({
      entryIdentity: (approved) => unitBuildIdentityFromRegistryEntry(approved),
    });

    expect(resolver.resolve({
      identity: identity({ capabilities: ["notifications"] }),
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("needs-approval");
  });

  it("returns preapproved for exact preapproved identity keys", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity();

    expect(resolver.resolve({
      identity: candidate,
      entry: null,
      preapprovedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
    }).decision).toBe("preapproved");
    expect(resolver.resolve({
      identity: identity({ effectiveVersion: "ev-next" }),
      entry: null,
      preapprovedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
    }).decision).toBe("needs-approval");
  });

  it("returns session-granted for exact session trust identity keys", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity();

    expect(resolver.resolve({
      identity: candidate,
      entry: null,
      sessionGrantedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
    }).decision).toBe("session-granted");
    expect(resolver.resolve({
      identity: identity({ effectiveVersion: "ev-next" }),
      entry: null,
      sessionGrantedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
    }).decision).toBe("needs-approval");
  });

  it("returns product-seed-trusted only when the seed source verifies", () => {
    const candidate = identity();
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>({
      productSeedTrust: (value) => value.name === candidate.name && value.effectiveVersion === "ev",
    });

    expect(resolver.resolve({ identity: candidate, entry: null }).decision).toBe("product-seed-trusted");
    expect(resolver.resolve({
      identity: identity({ effectiveVersion: "ev-next" }),
      entry: null,
    }).decision).toBe("needs-approval");
  });
});

describe("authorizeUnitSourcePush", () => {
  const descriptor = {
    kind: "extension",
    sourceRoot: "extensions",
    buildKind: "extension",
    approvalFraming: {
      serviceName: "extensions",
      unitLabel: "extension",
      unitLabelPlural: "extensions",
      nativeCode: true,
    },
    seedTrustEligible: true,
  } as const;
  const node = {
    name: "@workspace-extensions/a",
    relativePath: "extensions/a",
  };
  const activeEntry = entry({
    activeBundleKey: "bundle",
    activeEv: "ev",
    status: "running",
  });

  function makeGrantStore() {
    const active = new Set<string>();
    return {
      active,
      hasActive: (key: string) => active.has(key),
      grant: (key: string) => {
        active.add(key);
      },
    };
  }

  it("normalizes repo paths before ownership lookup", async () => {
    const grantStore = makeGrantStore();
    const seen: string[] = [];

    await authorizeUnitSourcePush({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: (repoPath) => {
        seen.push(repoPath);
        return null;
      },
      requestApproval: async () => "once",
    }, {
      caller: { runtime: { id: "panel:one", kind: "panel" } },
      repoPath: "workspace/extensions/a.git",
      branch: "main",
      commit: "abc",
    });

    expect(seen).toEqual(["extensions/a"]);
    expect(normalizeUnitRepoPath("/workspace/extensions/a.git/")).toBe("extensions/a");
  });

  it("denies unsupported runtime callers before prompting", async () => {
    const grantStore = makeGrantStore();
    const prompted: string[] = [];

    const result = await authorizeUnitSourcePush({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: activeEntry, node }),
      requestApproval: async () => {
        prompted.push("prompted");
        return "once";
      },
    }, {
      caller: { runtime: { id: "extension:one", kind: "extension" } },
      repoPath: "extensions/a",
      branch: "main",
      commit: "abc",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Extension source pushes from extension callers are not supported",
    });
    expect(prompted).toEqual([]);
  });

  it("records session grants after approval", async () => {
    const grantStore = makeGrantStore();
    const promptedBranches: string[] = [];
    const request = {
      caller: {
        runtime: { id: "panel:one", kind: "panel" },
        code: {
          callerKind: "panel",
          repoPath: "panels/main",
          effectiveVersion: "ev-panel",
        },
      },
      repoPath: "extensions/a",
      branch: "refs/heads/main",
      commit: "abc",
    };

    await expect(authorizeUnitSourcePush({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: activeEntry, node }),
      requestApproval: async ({ request: sourcePush }) => {
        promptedBranches.push(sourcePush.branch);
        return "session";
      },
    }, request)).resolves.toEqual({ allowed: true });

    await expect(authorizeUnitSourcePush({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: activeEntry, node }),
      requestApproval: async () => {
        promptedBranches.push("unexpected");
        return "session";
      },
    }, { ...request, branch: "main" })).resolves.toEqual({ allowed: true });

    expect(grantStore.active.has(
      unitPushSessionGrantKey("panel:one", "@workspace-extensions/a", "extensions/a", "main"),
    )).toBe(true);
    expect(promptedBranches).toEqual(["main"]);
  });

  it("gates source pushes to the installed unit ref instead of hardcoded main branches", async () => {
    const grantStore = makeGrantStore();
    const prompted: string[] = [];
    const featureEntry = entry({
      source: { kind: "internal-git", repo: "extensions/a", ref: "feature" },
      activeBundleKey: "bundle",
      status: "running",
    });
    const baseRequest = {
      caller: {
        runtime: { id: "panel:one", kind: "panel" },
        code: {
          callerKind: "panel",
          repoPath: "panels/main",
          effectiveVersion: "ev-panel",
        },
      },
      repoPath: "extensions/a",
      commit: "abc",
    };

    await expect(authorizeUnitSourcePush({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: featureEntry, node }),
      requestApproval: async () => {
        prompted.push("prompted");
        return "once";
      },
    }, { ...baseRequest, branch: "main" })).resolves.toEqual({ allowed: true });

    await expect(authorizeUnitSourcePush({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: featureEntry, node }),
      requestApproval: async () => {
        prompted.push("prompted");
        return "once";
      },
    }, { ...baseRequest, branch: "refs/heads/feature" })).resolves.toEqual({ allowed: true });

    expect(prompted).toEqual(["prompted"]);
  });
});

describe("requestUnitBatchApproval", () => {
  it("frames extension and app startup approvals from descriptors", async () => {
    const requested: unknown[] = [];
    const approvalQueue = {
      request: async (req: unknown) => {
        requested.push(req);
        return "once" as const;
      },
    };

    await requestUnitBatchApproval({
      descriptor: {
        kind: "extension",
        sourceRoot: "extensions",
        buildKind: "extension",
        approvalFraming: {
          serviceName: "extensions",
          unitLabel: "extension",
          unitLabelPlural: "extensions",
          nativeCode: true,
        },
        seedTrustEligible: true,
      },
      approvalQueue,
      entries: [{ unitKind: "extension" }],
      trigger: "startup",
    });
    expect(requested[requested.length - 1]).toMatchObject({
      callerId: "system:extensions",
      title: "Approve workspace extensions",
      description: "This workspace uses 1 native-code extension that needs approval to run as native code.",
    });

    await requestUnitBatchApproval({
      descriptor: {
        kind: "app",
        sourceRoot: "apps",
        buildKind: "app",
        approvalFraming: {
          serviceName: "apps",
          unitLabel: "app",
          unitLabelPlural: "apps",
          nativeCode: false,
        },
        seedTrustEligible: true,
      },
      approvalQueue,
      entries: [{ unitKind: "app" }, { unitKind: "app" }],
      trigger: "meta-push",
    });
    expect(requested[requested.length - 1]).toMatchObject({
      callerId: "system:apps",
      title: "Approve workspace apps",
      description: "This workspace uses 2 privileged apps that need approval to run in the app host.",
    });
  });
});

describe("UnitHost", () => {
  interface TestNode extends UnitGraphNode {
    version: string;
  }
  type TestDecl = UnitDeclaration;
  type TestApproval = { name: string; ref: string };

  function makeHarness(opts: {
    decision?: "once" | "deny";
    active?: boolean;
    productSeedTrust?: (identity: UnitBuildIdentity) => boolean;
    approvalCoordinator?: UnitApprovalCoordinator<TestApproval>;
    declarationVersion?: string | null;
    extraNode?: TestNode;
  } = {}) {
    const root = tempRoot();
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });
    if (opts.active) {
      registry.upsert(entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        status: "running",
      }));
    }
    const node: TestNode = {
      name: "@workspace-extensions/a",
      relativePath: "extensions/a",
      version: "1.0.0",
    };
    const nodes = [node, ...(opts.extraNode ? [opts.extraNode] : [])];
    const applied: string[] = [];
    const removed: string[] = [];
    const denied: string[][] = [];
    const requested: TestApproval[][] = [];
    const requestedTriggers: string[] = [];
    const host = new UnitHost<UnitRegistryEntryBase, TestDecl, TestNode, TestApproval>({
      descriptor: {
        kind: "extension",
        sourceRoot: "extensions",
        buildKind: "extension",
        approvalFraming: {
          serviceName: "extensions",
          unitLabel: "extension",
          unitLabelPlural: "extensions",
          nativeCode: true,
        },
        seedTrustEligible: true,
      },
      registry,
      currentDeclarationVersion: () =>
        opts.declarationVersion === undefined ? "meta-head" : opts.declarationVersion,
      resolveNode: (source) => {
        const match = nodes.find(
          (candidate) => source === candidate.relativePath || source === candidate.name,
        );
        if (!match) throw new Error("missing");
        return match;
      },
      candidateIdentity: (n, decl) => ({
        unitKind: "extension",
        name: n.name,
        source: { kind: "internal-git", repo: n.relativePath, ref: decl.ref },
        effectiveVersion: "ev",
        dependencyEvs: {},
        externalDeps: {},
      }),
      trustResolver: opts.productSeedTrust
        ? new UnitTrustResolver<UnitRegistryEntryBase>({ productSeedTrust: opts.productSeedTrust })
        : undefined,
      makePendingEntry: (n, decl, building) => entry({
        name: n.name,
        source: { kind: "internal-git", repo: n.relativePath, ref: decl.ref },
        status: building ? "building" : "pending-approval",
      }),
      applyTrusted: async (n) => {
        applied.push(n.name);
      },
      removeUndeclared: async (candidate) => {
        removed.push(candidate.name);
      },
      emitRemoved: () => undefined,
      notifyUnresolved: () => undefined,
      approvalEntry: (n, decl) => ({ name: n.name, ref: decl.ref }),
      requestApproval: async (entries, trigger) => {
        requested.push(entries);
        requestedTriggers.push(trigger);
        return opts.decision ?? "once";
      },
      approvalCoordinator: opts.approvalCoordinator,
      onApprovalDenied: (items) => denied.push(items.map((item) => item.node.name)),
      onBackgroundError: (err) => {
        throw err;
      },
    });
    return { host, registry, applied, removed, denied, requested, requestedTriggers, node };
  }

  it("prompts once for untrusted declarations and applies after approval", async () => {
    const { host, registry, applied, requested } = makeHarness();

    await host.reconcileDeclared([{ source: "extensions/a", ref: "main" }]);
    await host.whenSettled();

    expect(registry.get("@workspace-extensions/a")).toMatchObject({
      unitKind: "extension",
      status: "pending-approval",
    });
    expect(requested).toEqual([[{ name: "@workspace-extensions/a", ref: "main" }]]);
    expect(applied).toEqual(["@workspace-extensions/a"]);
  });

  it("enqueues coordinator approvals before reconcile resolves", async () => {
    let enqueued: TestApproval[] | null = null;
    let releaseApproval!: () => void;
    const approvalDone = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const { host, applied } = makeHarness({
      approvalCoordinator: {
        enqueue: async (request) => {
          enqueued = request.entries;
          await approvalDone;
          await request.applyApproved();
        },
      },
    });

    await host.reconcileDeclared([
      { source: "extensions/a", ref: "main" },
    ]);

    expect(enqueued).toEqual([{ name: "@workspace-extensions/a", ref: "main" }]);
    expect(applied).toEqual([]);

    releaseApproval();
    await host.whenSettled();

    expect(applied).toEqual(["@workspace-extensions/a"]);
  });

  it("propagates the reconcile trigger to background approval requests", async () => {
    const { host, requestedTriggers } = makeHarness();

    await host.reconcileDeclared(
      [{ source: "extensions/a", ref: "main" }],
      { trigger: "meta-push" },
    );
    await host.whenSettled();

    expect(requestedTriggers).toEqual(["meta-push"]);
  });

  it("uses preapproved trust for the matching declaration version without prompting", async () => {
    const { host, applied, requested, node } = makeHarness();
    host.acceptPreapprovedTrust("meta-head", [canonicalUnitBuildIdentity({
      unitKind: "extension",
      name: node.name,
      source: { kind: "internal-git", repo: node.relativePath, ref: "main" },
      effectiveVersion: "ev",
      dependencyEvs: {},
      externalDeps: {},
    })]);

    await host.reconcileDeclared([{ source: node.relativePath, ref: "main" }]);
    await host.whenSettled();

    expect(requested).toEqual([]);
    expect(applied).toEqual([node.name]);
  });

  it("preapproves declaration trust for the current declaration version", async () => {
    const { host, applied, requested, node } = makeHarness();

    const approval = host.preapproveDeclarations([{ source: node.relativePath, ref: "main" }]);

    expect(approval.identityKeys).toEqual([canonicalUnitBuildIdentity({
      unitKind: "extension",
      name: node.name,
      source: { kind: "internal-git", repo: node.relativePath, ref: "main" },
      effectiveVersion: "ev",
      dependencyEvs: {},
      externalDeps: {},
    })]);

    await host.reconcileDeclared([{ source: node.relativePath, ref: "main" }]);
    await host.whenSettled();

    expect(requested).toEqual([]);
    expect(applied).toEqual([node.name]);
  });

  it("merges multiple preapproval calls for the same declaration version", async () => {
    const extraNode: TestNode = {
      name: "@workspace-extensions/b",
      relativePath: "extensions/b",
      version: "1.0.0",
    };
    const { host, applied, requested, node } = makeHarness({ extraNode });

    host.preapproveDeclarations([{ source: node.relativePath, ref: "main" }]);
    host.preapproveDeclarations([{ source: extraNode.relativePath, ref: "main" }]);

    await host.reconcileDeclared([
      { source: node.relativePath, ref: "main" },
      { source: extraNode.relativePath, ref: "main" },
    ]);
    await host.whenSettled();

    expect(requested).toEqual([]);
    expect(applied).toEqual([node.name, extraNode.name]);
  });

  it("preapproves declaration trust for non-git declaration sources", async () => {
    const { host, applied, requested, node } = makeHarness({ declarationVersion: null });

    host.preapproveDeclarations([{ source: node.relativePath, ref: "main" }]);
    await host.reconcileDeclared([{ source: node.relativePath, ref: "main" }]);
    await host.whenSettled();

    expect(requested).toEqual([]);
    expect(applied).toEqual([node.name]);
  });

  it("collects approval entries and identity keys for untrusted declarations", () => {
    const { host, node } = makeHarness();

    expect(host.approvalForDeclarations([
      { source: node.relativePath, ref: "main" },
      { source: "extensions/missing", ref: "main" },
    ])).toEqual({
      entries: [{ name: node.name, ref: "main" }],
      identityKeys: [canonicalUnitBuildIdentity({
        unitKind: "extension",
        name: node.name,
        source: { kind: "internal-git", repo: node.relativePath, ref: "main" },
        effectiveVersion: "ev",
        dependencyEvs: {},
        externalDeps: {},
      })],
    });
  });

  it("does not collect approval entries for already approved declarations", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.approvalForDeclarations([
      { source: node.relativePath, ref: "main" },
    ])).toEqual({ entries: [], identityKeys: [] });
  });

  it("does not collect approval entries for product-seed-trusted declarations", () => {
    const { host, node } = makeHarness({
      productSeedTrust: (identity) => identity.source.repo === node.relativePath,
    });

    expect(host.approvalForDeclarations([
      { source: node.relativePath, ref: "main" },
    ])).toEqual({ entries: [], identityKeys: [] });
  });

  it("resolves declaration trust through the host identity pipeline", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.trustForDeclaration(node, {
      source: node.relativePath,
      ref: "main",
    })).toMatchObject({ decision: "user-approved" });
    expect(host.trustForDeclaration(node, {
      source: node.relativePath,
      ref: "feature",
    })).toMatchObject({ decision: "needs-approval" });
  });

  it("applies runtime declarations through the shared trust/build/activate flow", async () => {
    const { host, registry, node } = makeHarness({ active: true });
    const built: string[] = [];
    const activated: string[] = [];

    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => false,
      buildAndActivate: async () => {
        built.push("built");
      },
      activateCurrent: async (entryValue) => {
        activated.push(entryValue.name);
      },
    });
    expect(built).toEqual([]);
    expect(activated).toEqual([node.name]);

    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => true,
      buildAndActivate: async (n) => {
        built.push(n.name);
      },
      activateCurrent: async () => {
        activated.push("stale");
      },
    });
    expect(built).toEqual([node.name]);
    expect(activated).toEqual([node.name]);

    registry.delete(node.name);
    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => false,
      buildAndActivate: async (n) => {
        built.push(`missing:${n.name}`);
      },
      activateCurrent: async () => {
        activated.push("missing");
      },
    });
    expect(registry.get(node.name)).toMatchObject({ status: "building" });
    expect(built).toEqual([node.name, `missing:${node.name}`]);
  });

  it("marks runtime declaration failures as registry errors", async () => {
    const { host, registry, node } = makeHarness({ active: true });
    const errors: string[] = [];

    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => false,
      buildAndActivate: async () => undefined,
      activateCurrent: async () => {
        throw new Error("activation failed");
      },
      onError: (_node, _decl, message) => errors.push(message),
    });

    expect(registry.get(node.name)).toMatchObject({
      status: "error",
      lastError: "activation failed",
    });
    expect(errors).toEqual(["activation failed"]);
  });

  it("compares active build state with shared source, EV, dependency, and runtime keys", () => {
    const { host } = makeHarness({ active: true });
    const active = entry({
      activeEv: "ev",
      activeDependencyEvs: { dep: "ev-dep" },
      activeExternalDeps: { leftpad: "1.0.0" },
      activeRuntimeDepsKey: "runtime-key",
    });

    expect(host.activeSourceMatches(active, "workspace/extensions/a", "main")).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(false);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "feature",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev-next",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-next" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "2.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-next",
    })).toBe(true);
  });

  it("finds installed units by normalized repo path", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.findInstalledByRepo("/workspace/extensions/a.git")).toMatchObject({
      entry: expect.objectContaining({ name: node.name }),
      node,
    });
    expect(host.findInstalledByRepo("extensions/a/src/index.ts")).toMatchObject({
      entry: expect.objectContaining({ name: node.name }),
      node,
    });
    expect(host.findInstalledByRepo("apps/shell")).toBeNull();
  });

  it("removes registry entries that are no longer declared", async () => {
    const { host, registry, removed } = makeHarness({ active: true });

    await host.reconcileDeclared([]);

    expect(removed).toEqual(["@workspace-extensions/a"]);
    expect(registry.get("@workspace-extensions/a")).toBeNull();
  });
});
