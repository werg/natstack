export { HeadlessRunner } from "./runner.js";
export { TestRunner } from "./test-runner.js";
export { summarizeFailures, summarizeEntry } from "./diagnostics.js";
export { assertBrowserPanelHandle, refreshBrowserPanelHandle } from "./panel-guards.js";
export type { FailureDiagnostic, FailureReport, DiagnosticLimits } from "./diagnostics.js";
export type { TestCase, TestResult, TestSuiteResult, TestExecutionResult } from "./types.js";
export type { SessionSnapshot } from "@workspace/agentic-session";

// Stage report cards (runtime-safe: no value import of the .tsx renderer).
export { reportStage, ensureStageReportType, STAGE_REPORT_TYPE } from "./messages/report.js";
export type { StageReportState } from "./messages/report-types.js";

export {
  agentCapabilityTests,
  agenticRuntimeTests,
  allTests,
  buildTests,
  cdpGadDiagnosticTests,
  docsProbeTests,
  edgeCaseTests,
  filesystemTests,
  gitTests,
  harnessResilienceTests,
  interactionSurfaceTests,
  nextSelectedStage,
  notificationTests,
  oauthTests,
  panelTests,
  projectLifecycleTests,
  rpcTests,
  selectedTestStages,
  skillTests,
  smokeTests,
  testCategories,
  testStageChoices,
  testStages,
  workerTests,
  workspaceTests,
} from "./stages.js";
export type { NextTestStage, TestStage, TestStageChoice, TestStageRunState } from "./stages.js";
