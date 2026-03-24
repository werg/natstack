import type * as esbuild from "esbuild";
import type { FrameworkAdapter } from "./types.js";

export const svelteAdapter: FrameworkAdapter = {
  id: "svelte",

  dedupePackages: [
    "svelte",
    "svelte/internal",
  ],

  forcedSplitPackages: [],

  // Svelte uses its own compiler, no JSX
  jsx: undefined,
  tsconfigJsx: undefined,

  plugins(): esbuild.Plugin[] {
    const sveltePlugin = require("esbuild-svelte");
    return [
      sveltePlugin({
        compilerOptions: {
          css: "injected",
        },
      }),
    ];
  },

  generateEntry(exposeEntryFile: string, entryFile: string): string {
    return `import ${JSON.stringify(exposeEntryFile)};
import { autoMountSveltePanel, shouldAutoMount } from "@workspace/svelte";
import * as userModule from ${JSON.stringify(entryFile)};

if (shouldAutoMount(userModule)) {
  autoMountSveltePanel(userModule);
}
`;
  },

  // Minimal fallback HTML
  cdnStylesheets: [],
  additionalCss: "",
  rootElementHtml: '<div id="root"></div>',
};
