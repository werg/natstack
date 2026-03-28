/**
 * Shell client atom -- Jotai atom holding the active ShellClient instance.
 *
 * Set by LoginScreen after successful connection, read by MainScreen
 * and other components that need access to the PanelShell.
 */

import { atom } from "jotai";
import type { ShellClient } from "../services/shellClient";
import type { Panel } from "@shared/types";

/** The active ShellClient instance, or null if not connected */
export const shellClientAtom = atom<ShellClient | null>(null);

/** Derived atom for the current panel tree */
export const panelTreeAtom = atom<Panel[]>([]);
