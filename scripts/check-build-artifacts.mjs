import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const contracts = [
  {
    path: "dist/main.cjs",
    runtime: "Electron main",
    format: "cjs",
    mustContain: ["require(\"electron\")"],
    forbidden: [
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "CJS Electron main should have native require, not esbuild's ESM dynamic require fallback.",
      },
    ],
  },
  {
    path: "dist/server-electron.cjs",
    runtime: "Electron utilityProcess",
    format: "cjs",
    mustContain: ["\"use strict\""],
    forbidden: [
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "CJS utility-process server should have native require.",
      },
    ],
  },
  {
    path: "dist/server.mjs",
    runtime: "standalone Node server",
    format: "esm",
    mustContain: [
      "import { createRequire as __createRequire } from \"module\";",
      "const require = __createRequire(import.meta.url);",
    ],
  },
  {
    path: "dist/internal-do.bundle.mjs",
    runtime: "workerd/browser Durable Object bundle",
    format: "esm",
    forbidden: [
      {
        pattern: "__require(\"process\")",
        reason: "workerd/browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: "require(\"process\")",
        reason: "workerd/browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "workerd/browser bundles cannot rely on dynamic CommonJS require.",
      },
    ],
  },
  {
    path: "dist/browserTransport.js",
    runtime: "browser panel transport",
    format: "iife",
    forbidden: [
      {
        pattern: "__require(\"process\")",
        reason: "browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: "require(\"process\")",
        reason: "browser bundles cannot depend on Node's process module.",
      },
      {
        pattern: "throw Error('Dynamic require of \"",
        reason: "browser bundles cannot rely on dynamic CommonJS require.",
      },
    ],
  },
  {
    path: "packages/extension-host/dist/index.js",
    runtime: "Node ESM package",
    format: "esm",
    mustContain: [
      "import { createRequire as __createRequire } from \"node:module\";",
      "const require = __createRequire(import.meta.url);",
    ],
  },
  {
    path: "packages/extension-host/dist/childRuntime.js",
    runtime: "Node forked extension child runtime",
    format: "esm",
    mustContain: [
      "import { createRequire as __createRequire } from \"node:module\";",
      "const require = __createRequire(import.meta.url);",
    ],
    forbidden: [
      {
        pattern: "from \"electron\"",
        reason: "the forked extension child runtime must stay independent of Electron.",
      },
      {
        pattern: "require(\"electron\")",
        reason: "the forked extension child runtime must stay independent of Electron.",
      },
    ],
  },
  {
    path: "packages/process-adapter/dist/index.js",
    runtime: "Node ESM package",
    format: "esm",
    mustContain: ["createRequire(path.join(process.cwd(), \"package.json\"))"],
  },
];

const importSmokes = [
  {
    path: "packages/extension-host/dist/index.js",
    exportName: "ExtensionHost",
  },
  {
    path: "packages/process-adapter/dist/index.js",
    exportName: "createProcessAdapter",
  },
];

function readArtifact(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`${relativePath} does not exist. Run pnpm build first.`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function checkContract(contract) {
  const source = readArtifact(contract.path);
  for (const expected of contract.mustContain ?? []) {
    if (!source.includes(expected)) {
      throw new Error(
        `${contract.path} (${contract.runtime}) is missing expected text: ${expected}`,
      );
    }
  }
  for (const entry of contract.forbidden ?? []) {
    if (source.includes(entry.pattern)) {
      throw new Error(`${contract.path} (${contract.runtime}) violates contract: ${entry.reason}`);
    }
  }
}

async function runImportSmoke(smoke) {
  const absolutePath = path.join(repoRoot, smoke.path);
  const mod = await import(pathToFileURL(absolutePath).href);
  if (!(smoke.exportName in mod)) {
    throw new Error(`${smoke.path} did not export ${smoke.exportName}`);
  }
}

for (const contract of contracts) {
  checkContract(contract);
}

for (const smoke of importSmokes) {
  await runImportSmoke(smoke);
}

console.log(`[build-artifacts] ${contracts.length} contracts checked, ${importSmokes.length} import smokes passed.`);
