import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";

/**
 * Registry for React component mounts from kernel execution.
 *
 * When kernel code calls `mount(<Component />)`, the component
 * is registered here and rendered into a container element.
 */
export interface ReactMountRegistry {
  /** Register a React element and get its mount ID */
  registerElement(element: ReactNode): string;
  /** Get the container element for a mount ID */
  getContainer(mountId: string): HTMLElement | null;
  /** Get all mount IDs */
  getMountIds(): string[];
  /** Render a mount to its container */
  render(mountId: string, container: HTMLElement): void;
  /** Unmount and remove a mount */
  unmount(mountId: string): void;
  /** Clear all mounts */
  clear(): void;
  /** Create a mount function for kernel injection */
  createMountFunction(): (element: ReactNode) => string;
}

interface MountEntry {
  id: string;
  element: ReactNode;
  container: HTMLElement | null;
  root: Root | null;
}

/**
 * Create a React mount registry.
 */
export function createReactMount(): ReactMountRegistry {
  const mounts = new Map<string, MountEntry>();
  let mountCounter = 0;

  function generateMountId(): string {
    return `mount_${Date.now()}_${++mountCounter}`;
  }

  const registry: ReactMountRegistry = {
    registerElement(element: ReactNode): string {
      const id = generateMountId();
      mounts.set(id, {
        id,
        element,
        container: null,
        root: null,
      });
      return id;
    },

    getContainer(mountId: string): HTMLElement | null {
      return mounts.get(mountId)?.container ?? null;
    },

    getMountIds(): string[] {
      return Array.from(mounts.keys());
    },

    render(mountId: string, container: HTMLElement): void {
      const entry = mounts.get(mountId);
      if (!entry) return;

      // If already rendered, unmount first
      if (entry.root) {
        entry.root.unmount();
      }

      entry.container = container;
      entry.root = createRoot(container);
      entry.root.render(entry.element as React.ReactNode);
    },

    unmount(mountId: string): void {
      const entry = mounts.get(mountId);
      if (entry?.root) {
        entry.root.unmount();
        entry.root = null;
        entry.container = null;
      }
      mounts.delete(mountId);
    },

    clear(): void {
      for (const [id] of mounts) {
        registry.unmount(id);
      }
      mounts.clear();
      mountCounter = 0;
    },

    createMountFunction(): (element: ReactNode) => string {
      return (element: ReactNode): string => {
        const mountId = registry.registerElement(element);
        // Return the mount ID - the element will be rendered by the UI
        // when it processes the code result message
        return mountId;
      };
    },
  };

  return registry;
}

/**
 * Hook for rendering a mount in a React component.
 * Returns a ref to attach to the container element.
 */
export function useMountRenderer(
  registry: ReactMountRegistry,
  mountId: string | undefined
): React.RefCallback<HTMLElement> {
  return (element: HTMLElement | null) => {
    if (element && mountId) {
      registry.render(mountId, element);
    }
  };
}
