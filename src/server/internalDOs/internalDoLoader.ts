import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const INTERNAL_DO_SOURCE = "natstack/internal";

export const INTERNAL_DO_CLASSES = [
  "ScopeStoreDO",
  "WebhookStoreDO",
  "PanelStoreDO",
  "BrowserDataDO",
] as const;

export type InternalDOClassName = (typeof INTERNAL_DO_CLASSES)[number];

export interface InternalDOBundle {
  bundle: string;
  buildKey: string;
}

declare const globalThis: { __NATSTACK_INTERNAL_DO_BUNDLE__?: string };

let cached: InternalDOBundle | null = null;

export function isInternalDOSource(source: string): boolean {
  return source === INTERNAL_DO_SOURCE;
}

export function getInternalDOBundle(): InternalDOBundle {
  if (cached) return cached;
  cached = loadBundle();
  return cached;
}

function loadBundle(): InternalDOBundle {
  // Production path: the build inlines the internal-DO bundle as a string
  // constant via esbuild `define`, eliminating any runtime file lookup. See
  // `build.mjs` (the `internalDoBundleDefine` block).
  const inlined = typeof globalThis.__NATSTACK_INTERNAL_DO_BUNDLE__ === "string"
    ? globalThis.__NATSTACK_INTERNAL_DO_BUNDLE__
    : undefined;
  if (inlined && inlined.length > 0) {
    return {
      bundle: inlined,
      buildKey: createHash("sha256").update(inlined).digest("hex"),
    };
  }

  // Source/test path: fall back to reading the prebuilt bundle from disk.
  // Used by Vitest and any non-bundled execution. `pnpm build` produces the
  // bundle at `dist/internal-do.bundle.mjs`.
  const runtimeDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const appRoot = process.env["NATSTACK_APP_ROOT"] ?? process.cwd();
  const candidates = [
    path.join(runtimeDir, "internal-do.bundle.mjs"),
    path.resolve(appRoot, "dist/internal-do.bundle.mjs"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const bundle = fs.readFileSync(candidate, "utf8");
    return {
      bundle,
      buildKey: createHash("sha256").update(bundle).digest("hex"),
    };
  }
  throw new Error(
    `Internal Durable Object bundle not available. The production build inlines this via esbuild define; for source/test runs, build first with \`pnpm build\` so ${candidates.join(" or ")} exists.`,
  );
}
