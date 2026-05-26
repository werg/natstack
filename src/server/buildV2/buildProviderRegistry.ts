import type { BuildProvider, BuildProviderTarget } from "@natstack/shared/buildProvider";

const providers = new Map<BuildProviderTarget, BuildProvider>();
const listeners = new Set<(event: BuildProviderRegistryEvent) => void>();

export type BuildProviderRegistryEvent =
  | { type: "registered"; target: BuildProviderTarget; provider: BuildProvider }
  | { type: "unregistered"; target: BuildProviderTarget; provider: BuildProvider };

export function registerBuildProvider(provider: BuildProvider): void {
  const existing = providers.get(provider.target);
  if (existing && existing.name !== provider.name) {
    throw new Error(
      `Build provider target ${provider.target} is already registered by ${existing.name}`
    );
  }
  providers.set(provider.target, provider);
  notify({ type: "registered", target: provider.target, provider });
}

export function unregisterBuildProvider(target: BuildProviderTarget, name: string): void {
  const existing = providers.get(target);
  if (existing?.name === name) {
    providers.delete(target);
    notify({ type: "unregistered", target, provider: existing });
  }
}

export function resolveBuildProvider(target: BuildProviderTarget): BuildProvider {
  const provider = providers.get(target);
  if (!provider) throw new Error(`No build provider registered for target: ${target}`);
  return provider;
}

export function listBuildProviders(): BuildProvider[] {
  return [...providers.values()];
}

export function onBuildProviderChange(
  listener: (event: BuildProviderRegistryEvent) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearBuildProvidersForTests(): void {
  providers.clear();
  listeners.clear();
}

function notify(event: BuildProviderRegistryEvent): void {
  for (const listener of [...listeners]) listener(event);
}
