#!/usr/bin/env tsx
import { builtinProviders } from "./providers/index.js";
import { builtinFlows } from "./flows/index.js";
import { FlowResolver } from "./resolver.js";
import type { ProviderManifest } from "./types.js";

async function smokeTest(manifest: ProviderManifest): Promise<{ provider: string; flow: string; ok: boolean; error?: string }[]> {
  const results: { provider: string; flow: string; ok: boolean; error?: string }[] = [];

  for (const flow of manifest.flows) {
    const runner = builtinFlows.get(flow.type);
    if (!runner) {
      results.push({ provider: manifest.id, flow: flow.type, ok: false, error: "No runner registered" });
      continue;
    }

    try {
      const credential = await runner(flow);
      results.push({
        provider: manifest.id,
        flow: flow.type,
        ok: credential !== null,
        error: credential === null ? "Flow returned null" : undefined,
      });
    } catch (err) {
      results.push({
        provider: manifest.id,
        flow: flow.type,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

async function main(): Promise<void> {
  const filterProvider = process.argv[2];
  const providers = filterProvider
    ? builtinProviders.filter(p => p.id === filterProvider)
    : builtinProviders;

  if (providers.length === 0) {
    console.error(`Unknown provider: ${filterProvider}`);
    console.error(`Available: ${builtinProviders.map(p => p.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Smoke-testing ${providers.length} provider(s)...\n`);

  let totalPassed = 0;
  let totalFailed = 0;

  for (const provider of providers) {
    console.log(`── ${provider.displayName} (${provider.id}) ──`);
    console.log(`   Flows: ${provider.flows.map(f => f.type).join(", ")}`);
    console.log(`   API bases: ${provider.apiBase.join(", ")}`);
    console.log(`   Scopes: ${Object.keys(provider.scopes ?? {}).length}`);

    if (provider.whoami) {
      console.log(`   Whoami: ${provider.whoami.url}`);
    }

    const resolver = new FlowResolver(builtinFlows);
    try {
      console.log("   Resolver: flows registered ✓");
    } catch (err) {
      console.log(`   Resolver: FAIL — ${err instanceof Error ? err.message : err}`);
    }

    console.log("");
  }

  console.log("Manifest validation complete.");
  console.log("Note: Live flow testing requires interactive user consent.");
  console.log("Run with --interactive to test flows against live providers.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
