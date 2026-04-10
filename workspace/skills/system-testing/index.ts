export { HeadlessRunner } from "./runner.js";
export { TestRunner } from "./test-runner.js";
export type { TestCase, TestResult, TestSuiteResult, TestExecutionResult } from "./types.js";
export type { SessionSnapshot } from "@workspace/agentic-session";

// Test suite exports
export { smokeTests } from "./tests/smoke.js";
export { filesystemTests } from "./tests/filesystem.js";
export { databaseTests } from "./tests/database.js";
export { gitTests } from "./tests/git.js";
export { panelTests } from "./tests/panels.js";
export { workerTests } from "./tests/workers.js";
export { buildTests } from "./tests/build.js";
export { oauthTests } from "./tests/oauth.js";
export { workspaceTests } from "./tests/workspace.js";
export { notificationTests } from "./tests/notifications.js";
export { skillTests } from "./tests/skills.js";
export { agentCapabilityTests } from "./tests/agent-capabilities.js";
export { rpcTests } from "./tests/rpc-communication.js";
export { edgeCaseTests } from "./tests/edge-cases.js";

// Convenience: all tests combined
import { smokeTests as _smoke } from "./tests/smoke.js";
import { filesystemTests as _fs } from "./tests/filesystem.js";
import { databaseTests as _db } from "./tests/database.js";
import { gitTests as _git } from "./tests/git.js";
import { panelTests as _panels } from "./tests/panels.js";
import { workerTests as _workers } from "./tests/workers.js";
import { buildTests as _build } from "./tests/build.js";
import { oauthTests as _oauth } from "./tests/oauth.js";
import { workspaceTests as _ws } from "./tests/workspace.js";
import { notificationTests as _notif } from "./tests/notifications.js";
import { skillTests as _skills } from "./tests/skills.js";
import { agentCapabilityTests as _agent } from "./tests/agent-capabilities.js";
import { rpcTests as _rpc } from "./tests/rpc-communication.js";
import { edgeCaseTests as _edge } from "./tests/edge-cases.js";
import type { TestCase } from "./types.js";

export function allTests(): TestCase[] {
  return [
    ..._smoke, ..._fs, ..._db, ..._git, ..._panels, ..._workers,
    ..._build, ..._oauth, ..._ws, ..._notif, ..._skills,
    ..._agent, ..._rpc, ..._edge,
  ];
}
