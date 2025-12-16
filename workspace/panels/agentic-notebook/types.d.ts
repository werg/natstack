// Type declarations for external packages without bundled types

declare module "react-syntax-highlighter" {
  import { ComponentType, ReactNode } from "react";

  export interface SyntaxHighlighterProps {
    children?: ReactNode;
    language?: string;
    style?: Record<string, unknown>;
    showLineNumbers?: boolean;
    wrapLongLines?: boolean;
    customStyle?: React.CSSProperties;
    codeTagProps?: { style?: React.CSSProperties };
  }

  export const Prism: ComponentType<SyntaxHighlighterProps>;
  export const Light: ComponentType<SyntaxHighlighterProps>;
  export default ComponentType<SyntaxHighlighterProps>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism" {
  const oneDark: Record<string, unknown>;
  export { oneDark };
}

declare module "react-virtuoso" {
  import { ReactNode, RefObject } from "react";

  export interface VirtuosoProps<T = unknown> {
    data?: T[];
    totalCount?: number;
    itemContent?: (index: number, item: T) => ReactNode;
    computeItemKey?: (index: number, item: T) => string | number;
    followOutput?: boolean | "auto" | "smooth";
    initialTopMostItemIndex?: number;
    alignToBottom?: boolean;
    style?: React.CSSProperties;
    className?: string;
    ref?: RefObject<VirtuosoHandle>;
    components?: {
      EmptyPlaceholder?: () => ReactNode;
      Header?: () => ReactNode;
      Footer?: () => ReactNode;
      [key: string]: (() => ReactNode) | undefined;
    };
  }

  export interface VirtuosoHandle {
    scrollToIndex: (options: { index: number; behavior?: "auto" | "smooth" }) => void;
    scrollTo: (options: { top: number; behavior?: "auto" | "smooth" }) => void;
  }

  export function Virtuoso<T>(props: VirtuosoProps<T>): JSX.Element;
}
