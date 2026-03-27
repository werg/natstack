import type { FrameworkAdapter } from "./types.js";

export const reactAdapter: FrameworkAdapter = {
  id: "react",

  dedupePackages: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
  ],

  forcedSplitPackages: [
    "@radix-ui/react-icons",
  ],

  jsx: "automatic",
  tsconfigJsx: "react-jsx",

  generateEntry(exposeEntryFile: string, entryFile: string): string {
    return `import ${JSON.stringify(exposeEntryFile)};
import { autoMountReactPanel, shouldAutoMount } from "@workspace/react";
import * as userModule from ${JSON.stringify(entryFile)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
  },

  // Fallback HTML defaults (used only when no workspace template is found)
  cdnStylesheets: [
    "https://cdn.jsdelivr.net/npm/@radix-ui/themes@3.2.1/styles.css",
  ],
  additionalCss: "#root, #root > .radix-themes { min-height: 100dvh; }",
  rootElementHtml: '<div id="root"></div>',
};
