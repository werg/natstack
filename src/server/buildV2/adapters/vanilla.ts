import type { FrameworkAdapter } from "./types.js";

export const vanillaAdapter: FrameworkAdapter = {
  id: "vanilla",

  dedupePackages: [],
  forcedSplitPackages: [],

  // No JSX transform
  jsx: undefined,
  tsconfigJsx: undefined,

  generateEntry(exposeEntryFile: string, entryFile: string): string {
    return `import ${JSON.stringify(exposeEntryFile)};
import ${JSON.stringify(entryFile)};
`;
  },

  // Minimal fallback HTML
  cdnStylesheets: [],
  additionalCss: "",
  rootElementHtml: '<div id="root"></div>',
};
