import type { Credential, FlowConfig } from "./types.js";

export type FlowRunner = (config: FlowConfig) => Promise<Credential | null>;

export class FlowResolver {
  constructor(private runners: Map<string, FlowRunner>) {}

  async resolve(flows: FlowConfig[]): Promise<Credential> {
    for (const flow of flows) {
      const runner = this.runners.get(flow.type);

      if (!runner) {
        continue;
      }

      const credential = await runner(flow);

      if (credential) {
        return credential;
      }
    }

    throw new Error("No credential flow succeeded");
  }

  registerRunner(type: string, runner: FlowRunner): void {
    this.runners.set(type, runner);
  }
}
