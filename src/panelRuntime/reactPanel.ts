import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";
import panelAPI, { createRadixThemeProvider } from "./panelApi";

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

  return function mountReactPanel<Props>(
    Component: ComponentType<Props>,
    initialProps?: Props
  ): ReactPanelInstance<Props> {
    const container = document.getElementById(rootId);
    if (!container) {
      throw new Error(`React root element '#${rootId}' not found in panel DOM`);
    }

    const root = createRootFn(container);
    let currentProps = initialProps ?? ({} as Props);

    const render = (nextProps?: Props) => {
      if (nextProps) {
        currentProps = nextProps;
      }

      let tree = ReactLib.createElement(Component as ComponentType<any>, currentProps as any);
      if (ThemeProvider) {
        tree = ReactLib.createElement(ThemeProvider as ComponentType<any>, undefined, tree);
      }
      root.render(tree);
    };

    render(currentProps);

    return {
      update: render,
      unmount: () => root.unmount(),
      root,
    };
  };
}

export default panelAPI;
