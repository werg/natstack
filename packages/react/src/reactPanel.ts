import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";
import { getTheme, onThemeChange, onConnectionError } from "@natstack/runtime";

export interface ReactPanelOptions {
  rootId?: string;
  ThemeComponent?: ComponentType<{ appearance: "light" | "dark"; children?: ReactNode }>;
}

type ReactNamespace = typeof import("react");
type CreateRootFn = typeof import("react-dom/client").createRoot;

export interface ReactPanelInstance<Props> {
  update: (nextProps?: Props) => void;
  unmount: () => void;
  root: Root;
}

export function createReactPanelMount(
  ReactLib: ReactNamespace,
  createRootFn: CreateRootFn,
  options?: ReactPanelOptions
) {
  const rootId = options?.rootId ?? "root";
  const ThemeProvider = options?.ThemeComponent
    ? (() => {
        const ThemeComponent = options.ThemeComponent!;
        return function NatstackRadixThemeProvider({ children }: { children?: ReactNode }): ReactNode {
          const [theme, setTheme] = ReactLib.useState(() => getTheme());

          ReactLib.useEffect(() => {
            let mounted = true;
            const unsubscribe = onThemeChange((nextTheme) => {
              if (mounted) setTheme(nextTheme);
            });
            return () => {
              mounted = false;
              unsubscribe();
            };
          }, []);

          return ReactLib.createElement(ThemeComponent, { appearance: theme }, children);
        };
      })()
    : null;

  function ConnectionErrorBarrier({ children }: { children: ReactNode }): ReactNode {
    const [connError, setConnError] = ReactLib.useState<{ code: number; reason: string; source?: "electron" | "server" } | null>(null);

    ReactLib.useEffect(() => {
      return onConnectionError((err) => setConnError(err));
    }, []);

    if (connError) {
      if (connError.source === "server") {
        // Non-blocking banner — panel is still functional for navigation/UI
        return ReactLib.createElement(ReactLib.Fragment, null,
          ReactLib.createElement("div", {
            style: {
              padding: "8px 16px", background: "#fef3cd", color: "#856404",
              fontSize: 13, textAlign: "center", borderBottom: "1px solid #ffc107",
            },
          }, `Backend unavailable: ${connError.reason}`),
          children,
        );
      }
      // Full-screen overlay — panel is disconnected from the app
      return ReactLib.createElement("div", {
        style: {
          position: "fixed", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--color-background, #fff)",
          color: "var(--color-text, #111)",
          fontFamily: "system-ui, sans-serif",
          zIndex: 2147483647,
        },
      },
        ReactLib.createElement("div", { style: { textAlign: "center", maxWidth: 400, padding: 24 } },
          ReactLib.createElement("div", { style: { fontSize: 18, fontWeight: 600, marginBottom: 8 } }, "Connection lost"),
          ReactLib.createElement("div", { style: { fontSize: 14, opacity: 0.7 } }, connError.reason),
        ),
      );
    }

    return ReactLib.createElement(ReactLib.Fragment, null, children);
  }

  const Wrapper: ComponentType<{ children: ReactNode }> = ThemeProvider
    ? ({ children }) => ReactLib.createElement(ConnectionErrorBarrier, null, ReactLib.createElement(ThemeProvider, null, children))
    : ({ children }) => ReactLib.createElement(ConnectionErrorBarrier, null, children);

  return function mountReactPanel<Props>(
    Component: ComponentType<Props>,
    initialProps?: Props
  ): ReactPanelInstance<Props> {
    const container = document.getElementById(rootId);
    if (!container) {
      throw new Error(`React root element '#${rootId}' not found in panel DOM`);
    }

    const existingRoot = (container as any)._reactRoot;
    const root = existingRoot ?? createRootFn(container);
    if (!existingRoot) {
      (container as any)._reactRoot = root;
    }
    let currentProps = initialProps ?? ({} as Props);

    const render = (nextProps?: Props) => {
      if (nextProps) {
        currentProps = nextProps;
      }

      root.render(
        ReactLib.createElement(
          Wrapper,
          null,
          ReactLib.createElement(Component as ComponentType<any>, currentProps as any)
        )
      );
    };

    render(currentProps);

    return {
      update: render,
      unmount: () => root.unmount(),
      root,
    };
  };
}
