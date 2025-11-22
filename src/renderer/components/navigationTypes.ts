export type NavigationMode = "stack" | "tree";

export interface AncestorCrumb {
  path: string[];
  siblings: Panel[];
}

export interface SiblingGroup {
  parentPath: string[];
  siblings: Panel[];
  activeId: string;
}

export interface TitleNavigationData {
  ancestors: AncestorCrumb[];
  current: SiblingGroup | null;
  currentTitle: string;
}

export interface StatusNavigationData {
  descendantGroups: Array<{
    pathToParent: string[];
    children: Panel[];
    selectedChildId: string | null;
    parentId: string;
  }>;
}
