import type * as esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";
import type { FrameworkAdapter } from "./types.js";

export const svelteAdapter: FrameworkAdapter = {
  id: "svelte",

  dedupePackages: ["svelte", "svelte/internal"],

  forcedSplitPackages: [],

  // Svelte uses its own compiler, no JSX
  jsx: undefined,
  tsconfigJsx: undefined,

  plugins(): esbuild.Plugin[] {
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
