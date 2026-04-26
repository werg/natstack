import type { Credential, FlowConfig } from "./types.js";

export type FlowRunner = (config: FlowConfig, providerId?: string) => Promise<Credential | null>;

export class FlowResolver {
  constructor(private runners: Map<string, FlowRunner>) {}

  async resolve(flows: FlowConfig[], providerId?: string): Promise<Credential> {
    for (const flow of flows) {
      const runner = this.runners.get(flow.type);

      if (!runner) {
        continue;
      }

      const credential = providerId === undefined
        ? await runner(flow)
        : await runner(flow, providerId);

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
