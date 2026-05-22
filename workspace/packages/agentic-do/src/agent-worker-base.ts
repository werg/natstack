/**
 * AgentWorkerBase — workspace-default channel agent DO base.
 *
 * The reusable channel-agent vessel lives in `TrajectoryVesselBase`.
 * This subclass preserves the public import path used by existing AiChat
 * agents while leaving room for concrete workers, such as Gmail, to extend
 * the vessel directly.
 */

import type { DurableObjectContext } from "@workspace/runtime/worker";

import {
  TrajectoryVesselBase,
  type ModelCredentialSetupProps,
  type ModelCredentialSummary,
} from "./trajectory-vessel-base.js";

export type { ModelCredentialSetupProps, ModelCredentialSummary };

export abstract class AgentWorkerBase extends TrajectoryVesselBase {
  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }
}
