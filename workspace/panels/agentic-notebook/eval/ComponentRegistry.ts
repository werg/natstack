import type { ComponentType } from "react";

/**
 * Registry for React component definitions returned by code execution.
 *
 * This bridges the gap between the non-serializable component functions
 * returned by `eval` and the serializable messages sent to the UI.
 */
export interface ComponentRegistry {
  /** Register a component and get its ID */
  register(component: ComponentType): string;
  /** Register a component with a specific ID (for rehydration) */
  registerWithId(id: string, component: ComponentType): void;
  /** Get a component by ID */
  get(id: string): ComponentType | undefined;
  /** Clear all components */
  clear(): void;
  /** Get current size */
  size(): number;
}

/**
 * Options for creating a component registry.
 */
export interface ComponentRegistryOptions {
  /** Maximum number of components to keep in registry. Default: 100 */
  maxSize?: number;
}

/**
 * Create a component registry with LRU eviction.
 *
 * **Eviction behavior**: When the registry reaches `maxSize` (default 100),
 * the least recently accessed component is evicted. If a component is evicted
 * before the UI renders it, the UI will attempt to rehydrate it by re-executing
 * the source code (if available in the message data).
 *
 * For typical usage with fewer than 100 active components, eviction is rare.
 */
export function createComponentRegistry(
  options: ComponentRegistryOptions = {}
): ComponentRegistry {
  const { maxSize = 100 } = options;
  const components = new Map<string, ComponentType>();
  // Use Map for O(1) access order tracking instead of array with indexOf/splice
  const accessOrder = new Map<string, number>();
  let accessCounter = 0;
  let idCounter = 0;

  function trackAccess(id: string) {
    accessOrder.set(id, ++accessCounter);
  }

  function evictIfNeeded() {
    while (components.size >= maxSize && accessOrder.size > 0) {
      // Find the entry with the lowest access counter (LRU)
      let oldestId: string | undefined;
      let oldestCounter = Infinity;
      for (const [id, counter] of accessOrder) {
        if (counter < oldestCounter) {
          oldestCounter = counter;
          oldestId = id;
        }
      }
      if (oldestId) {
        components.delete(oldestId);
        accessOrder.delete(oldestId);
      }
    }
  }

  return {
    register(component: ComponentType): string {
      evictIfNeeded();
      const id = `comp_${Date.now()}_${++idCounter}`;
      components.set(id, component);
      trackAccess(id);
      return id;
    },

    registerWithId(id: string, component: ComponentType): void {
      // If updating existing, don't count as new entry
      if (!components.has(id)) {
        evictIfNeeded();
      }
      components.set(id, component);
      trackAccess(id);
    },

    get(id: string): ComponentType | undefined {
      const component = components.get(id);
      if (component) {
        trackAccess(id);
      }
      return component;
    },

    clear(): void {
      components.clear();
      accessOrder.clear();
      accessCounter = 0;
      idCounter = 0;
    },

    size(): number {
      return components.size;
    },
  };
}

/**
 * Global singleton instance.
 * Since we are in the same heap/context as the UI, we can share this.
 */
export const componentRegistry = createComponentRegistry();
