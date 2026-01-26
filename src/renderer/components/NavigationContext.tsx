import { createContext, useContext, useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import type {
  NavigationMode,
  LazyTitleNavigationData,
  LazyStatusNavigationData,
} from "./navigationTypes";

interface NavigationContextValue {
  mode: NavigationMode;
  setMode: (mode: NavigationMode) => void;
  // ID-based lazy navigation
  lazyTitleNavigation: LazyTitleNavigationData | null;
  setLazyTitleNavigation: (data: LazyTitleNavigationData | null) => void;
  lazyStatusNavigation: LazyStatusNavigationData | null;
  setLazyStatusNavigation: (data: LazyStatusNavigationData | null) => void;
  navigateToId: (panelId: string) => void;
  registerNavigateToId: (fn: (panelId: string) => void) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function useNavigation(): NavigationContextValue {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error("useNavigation must be used within a NavigationProvider");
  }
  return context;
}

interface NavigationProviderProps {
  children: ReactNode;
}

export function NavigationProvider({ children }: NavigationProviderProps) {
  const [mode, setMode] = useState<NavigationMode>("stack");

  // ID-based lazy navigation state
  const [lazyTitleNavigation, setLazyTitleNavigation] = useState<LazyTitleNavigationData | null>(null);
  const [lazyStatusNavigation, setLazyStatusNavigation] = useState<LazyStatusNavigationData | null>(null);

  // Use ref for stable navigateToId callback (prevents listener cycling)
  const navigateToIdFnRef = useRef<(panelId: string) => void>(() => {});

  const navigateToId = useCallback(
    (panelId: string) => {
      navigateToIdFnRef.current(panelId);
    },
    [] // Stable forever - no dependencies
  );

  const registerNavigateToId = useCallback((fn: (panelId: string) => void) => {
    navigateToIdFnRef.current = fn;
  }, []);

  const value = useMemo<NavigationContextValue>(
    () => ({
      mode,
      setMode,
      lazyTitleNavigation,
      setLazyTitleNavigation,
      lazyStatusNavigation,
      setLazyStatusNavigation,
      navigateToId,
      registerNavigateToId,
    }),
    [
      mode,
      lazyTitleNavigation,
      lazyStatusNavigation,
      navigateToId,
      registerNavigateToId,
    ]
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}
