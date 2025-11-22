import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import type { NavigationMode, StatusNavigationData, TitleNavigationData } from "./navigationTypes";

interface NavigationContextValue {
  mode: NavigationMode;
  setMode: (mode: NavigationMode) => void;
  titleNavigation: TitleNavigationData | null;
  setTitleNavigation: (data: TitleNavigationData | null) => void;
  statusNavigation: StatusNavigationData | null;
  setStatusNavigation: (data: StatusNavigationData | null) => void;
  navigate: (path: string[]) => void;
  registerNavigate: (fn: (path: string[]) => void) => void;
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
  const [titleNavigation, setTitleNavigation] = useState<TitleNavigationData | null>(null);
  const [statusNavigation, setStatusNavigation] = useState<StatusNavigationData | null>(null);
  const [navigateFn, setNavigateFn] = useState<(path: string[]) => void>(() => () => {});

  const navigate = useCallback(
    (path: string[]) => {
      navigateFn(path);
    },
    [navigateFn]
  );

  const registerNavigate = useCallback((fn: (path: string[]) => void) => {
    setNavigateFn(() => fn);
  }, []);

  const value = useMemo<NavigationContextValue>(
    () => ({
      mode,
      setMode,
      titleNavigation,
      setTitleNavigation,
      statusNavigation,
      setStatusNavigation,
      navigate,
      registerNavigate,
    }),
    [mode, titleNavigation, statusNavigation, navigate, registerNavigate]
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}
