import { atom } from "jotai";
import type { KernelManager } from "../kernel/KernelManager";

/**
 * The current kernel manager instance.
 */
export const kernelAtom = atom<KernelManager | null>(null);

/**
 * Atom for kernel execution count.
 */
export const kernelExecutionCountAtom = atom<number>(0);

/**
 * Atom for whether kernel is currently executing.
 */
export const kernelExecutingAtom = atom<boolean>(false);
