import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";
import { panel, createRadixThemeProvider } from "@natstack/core";

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
    ? createRadixThemeProvider(ReactLib, options.ThemeComponent)
    : null;

  const Wrapper: ComponentType<{ children: ReactNode }> = ThemeProvider
    ? ({ children }) => ReactLib.createElement(ThemeProvider, null, children)
    : ({ children }) => ReactLib.createElement(ReactLib.Fragment, null, children);

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

export default panel;
