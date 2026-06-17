import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnitBatchEntry } from "@natstack/shared/approvals";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import {
  unitChangeSessionGrantKey,
  type UnitMetaChangeApprovalProvider,
} from "@natstack/unit-host";
import type { StateAdvancedEvent } from "../buildV2/stateTrigger.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  createMainAdvanceApprovalGate,
  type MetaApprovalGrantStore,
} from "./mainAdvanceApproval.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempStatePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-main-advance-"));
  roots.push(root);
  return root;
}

class MemoryGrantStore implements MetaApprovalGrantStore {
  readonly grants = new Map<string, number>();

  hasActive(key: string): boolean {
    const expiresAt = this.grants.get(key);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  grant(key: string, ttlMs: number): void {
    this.grants.set(key, Date.now() + ttlMs);
  }
}

const unit: UnitBatchEntry = {
  unitKind: "extension",
  unitName: "@workspace-extensions/tools",
  displayName: "Tools",
  version: "1.0.0",
  source: { kind: "workspace-repo", repo: "extensions/tools", ref: "main" },
  capabilities: [],
};

function stateAdvance(overrides: Partial<StateAdvancedEvent> = {}): StateAdvancedEvent {
  return {
    head: "main",
    stateHash: "state:next",
    sinceStateHash: "state:prev",
    eventId: "event:1",
    headHash: "head:1",
    actor: { id: "panel-1", kind: "panel" },
    transitionKind: "merge",
    changedPaths: ["meta/natstack.yml"],
    fileChanges: [],
    editOps: [],
    ...overrides,
  };
}

function panelCaller() {
  return createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-panel",
  });
}

function approvalQueue(decision: "once" | "session" | "version" | "repo" | "deny") {
  return {
    request: vi.fn(async () => decision),
  } as unknown as ApprovalQueue & { request: ReturnType<typeof vi.fn> };
}

function gateDeps(opts: { decision?: "once" | "session" | "version" | "repo" | "deny" } = {}) {
  const queue = approvalQueue(opts.decision ?? "once");
  const grantStore = new MemoryGrantStore();
  return {
    approvalQueue: queue,
    grantStore,
    grantTtlMs: 1000,
    capabilityGrantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    getProviders: () => [] as UnitMetaChangeApprovalProvider<UnitBatchEntry>[],
  };
}

describe("createMainAdvanceApprovalGate", () => {
  it("approves main meta advances with the semantic unit-batch prompt", async () => {
    const deps = gateDeps({ decision: "session" });
    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
    });

    await gate.approve({
      event: stateAdvance(),
      caller: panelCaller(),
      operation: "publish",
      sourceHead: "ctx:ctx-1",
    });

    expect(provider.metaChangeApprovalForCommit).toHaveBeenCalledWith("state:next");
    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        trigger: "meta-change",
        configWrite: {
          repoPath: "meta",
          summary: "meta/natstack.yml changed",
        },
        units: [unit],
      })
    );
    expect(
      deps.grantStore.hasActive(unitChangeSessionGrantKey("panel-1", "meta", "meta", "main"))
    ).toBe(true);
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledWith(["identity:unit"]);
  });

  it("does not re-prompt for the same preapproved meta identity on retry", async () => {
    const deps = gateDeps({ decision: "once" });
    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({
        units: [unit],
        identityKeys: ["identity:unit"],
      })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [provider],
    });
    const candidate = {
      event: stateAdvance(),
      caller: panelCaller(),
      operation: "publish" as const,
      sourceHead: "ctx:ctx-1",
    };

    await gate.approve(candidate);
    await gate.approve(candidate);

    expect(deps.approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(provider.acceptPreapprovedTrust).toHaveBeenCalledTimes(2);
  });

  it("approves non-meta main advances with the workspace repo write capability prompt", async () => {
    const deps = gateDeps({ decision: "repo" });
    const provider: UnitMetaChangeApprovalProvider<UnitBatchEntry> = {
      metaChangeApprovalForCommit: vi.fn(async () => ({ units: [unit], identityKeys: [] })),
      acceptPreapprovedTrust: vi.fn(),
    };
    const gate = createMainAdvanceApprovalGate({ ...deps, getProviders: () => [provider] });

    await gate.approve({
      event: stateAdvance({ changedPaths: ["apps/shell/index.tsx"], transitionKind: "edit" }),
      caller: panelCaller(),
      operation: "publish",
      sourceHead: "ctx:ctx-1",
    });

    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        capability: "workspace-repo-write",
        grantResourceKey: "workspace-source-change:main",
        title: "Publish workspace changes",
        description: "This vcs publish moves workspace main and changes 1 path.",
        resource: {
          type: "vcs-head",
          label: "Head",
          value: "workspace main",
        },
        details: [
          { label: "Operation", value: "vcs publish" },
          { label: "Head", value: "main" },
          { label: "Source", value: "ctx:ctx-1" },
          { label: "State", value: "state:next" },
          { label: "Changes", value: "apps/shell/index.tsx" },
        ],
      })
    );
    expect(provider.metaChangeApprovalForCommit).not.toHaveBeenCalled();
  });

  it("does not let meta session grants skip mixed workspace changes", async () => {
    const deps = gateDeps({ decision: "once" });
    deps.grantStore.grant(unitChangeSessionGrantKey("panel-1", "meta", "meta", "main"), 1000);
    const gate = createMainAdvanceApprovalGate({
      ...deps,
      getProviders: () => [
        {
          metaChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
          acceptPreapprovedTrust: vi.fn(),
        },
      ],
    });

    await gate.approve({
      event: stateAdvance({
        changedPaths: ["meta/natstack.yml", "apps/shell/index.tsx"],
      }),
      caller: panelCaller(),
      operation: "publish",
      sourceHead: "ctx:ctx-1",
    });

    expect(deps.approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        configWrite: {
          repoPath: "meta",
          summary: "meta/natstack.yml changed; 1 other workspace path changed",
        },
      })
    );
  });

  it("rejects denied main meta advances", async () => {
    const gate = createMainAdvanceApprovalGate({
      ...gateDeps({ decision: "deny" }),
      getProviders: () => [
        {
          metaChangeApprovalForCommit: vi.fn(async () => ({ units: [], identityKeys: [] })),
          acceptPreapprovedTrust: vi.fn(),
        },
      ],
    });

    await expect(
      gate.approve({
        event: stateAdvance(),
        caller: panelCaller(),
        operation: "apply-edits",
      })
    ).rejects.toThrow("Workspace config publish denied");
  });

  it("rejects denied non-meta main advances", async () => {
    const gate = createMainAdvanceApprovalGate(gateDeps({ decision: "deny" }));

    await expect(
      gate.approve({
        event: stateAdvance({ changedPaths: ["panels/spectrolite/index.tsx"] }),
        caller: panelCaller(),
        operation: "merge",
        sourceHead: "ctx:ctx-1",
      })
    ).rejects.toThrow("Workspace main update denied");
  });
});
