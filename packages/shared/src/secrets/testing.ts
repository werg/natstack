import type { SecretsStore } from "./secretsStore.js";

type KeyListener = (value: string | undefined) => void;
type AllListener = (key: string, value: string | undefined) => void;

export function createInMemorySecretsStore(initial: Record<string, string> = {}): SecretsStore {
  const values = new Map<string, string>(Object.entries(initial));
  const keyListeners = new Map<string, Set<KeyListener>>();
  const allListeners = new Set<AllListener>();

  const emit = (key: string, value: string | undefined): void => {
    const listeners = keyListeners.get(key);
    if (listeners) {
      for (const listener of listeners) {
        listener(value);
      }
    }
    for (const listener of allListeners) {
      listener(key, value);
    }
  };

  return {
    get(key) {
      return values.get(key);
    },
    require(key) {
      const value = values.get(key);
      if (value !== undefined) return value;
      throw new Error(`Missing required secret "${key}".`);
    },
    has(key) {
      return values.has(key);
    },
    list() {
      return [...values.keys()].sort((left, right) => left.localeCompare(right));
    },
    watch(key, fn) {
      const listeners = keyListeners.get(key) ?? new Set<KeyListener>();
      listeners.add(fn);
      keyListeners.set(key, listeners);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) {
          keyListeners.delete(key);
        }
      };
    },
    watchAll(fn) {
      allListeners.add(fn);
      return () => {
        allListeners.delete(fn);
      };
    },
    async set(key, value) {
      if (values.get(key) === value) return;
      values.set(key, value);
      emit(key, value);
    },
    async delete(key) {
      if (!values.has(key)) return;
      values.delete(key);
      emit(key, undefined);
    },
    async close() {},
  };
}
