import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { BuildProviderInput, BuildProviderOutput } from "@natstack/shared/buildProvider";

export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@natstack/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/react-native": Api;
  }
}

interface ArtifactFile {
  filePath: string;
  tempDir: string;
}

const require = createRequire(import.meta.url);

export async function activate() {
  const artifactFiles = new Map<string, ArtifactFile>();
  const tempDirRefs = new Map<string, number>();
  return {
    async build(input: BuildProviderInput): Promise<BuildProviderOutput> {
      if (input.target !== "react-native") {
        throw new Error(`react-native provider cannot build target: ${input.target}`);
      }
      const appManifest = input.manifest["app"] && typeof input.manifest["app"] === "object"
        ? input.manifest["app"] as Record<string, unknown>
        : input.manifest;
      const entry = String(appManifest["renderer"] ?? "index.tsx");
      const entryPath = path.resolve(input.sourcePath, entry);
      const rnHostAbi = typeof appManifest["rnHostAbi"] === "string"
        ? appManifest["rnHostAbi"]
        : null;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-rn-provider-"));
      const artifacts: BuildProviderOutput["artifacts"] = [];
      for (const platform of ["android", "ios"] as const) {
        const bundlePath = path.join(tempDir, `index.${platform}.bundle`);
        const assetsDir = path.join(tempDir, `${platform}-assets`);
        fs.mkdirSync(assetsDir, { recursive: true });
        await runReactNativeBundle(input, platform, entryPath, bundlePath, assetsDir);
        const bundleArtifactId = randomUUID();
        artifactFiles.set(bundleArtifactId, { filePath: bundlePath, tempDir });
        artifacts.push({
          path: `index.${platform}.bundle`,
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform,
          stream: { method: "buildArtifact", args: [bundleArtifactId] },
        });
        for (const assetPath of walkFiles(assetsDir)) {
          const assetArtifactId = randomUUID();
          artifactFiles.set(assetArtifactId, { filePath: assetPath, tempDir });
          artifacts.push({
            path: `assets/${platform}/${path.relative(assetsDir, assetPath).replace(/\\/g, "/")}`,
            role: "asset",
            contentType: contentTypeForPath(assetPath),
            encoding: "base64",
            platform,
            stream: { method: "buildArtifact", args: [assetArtifactId] },
          });
        }
      }
      tempDirRefs.set(tempDir, artifacts.length);
      return {
        artifacts,
        metadata: {
          rnHostAbi,
        },
      };
    },
    buildArtifact(artifactId: string): ReadableStream<Uint8Array> {
      const artifact = artifactFiles.get(artifactId);
      if (!artifact) {
        throw new Error("Unknown React Native build artifact");
      }
      artifactFiles.delete(artifactId);
      const source = fs.createReadStream(artifact.filePath);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          source.on("data", (chunk) => {
            controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
          });
          source.on("error", (error) => controller.error(error));
          source.on("end", () => {
            controller.close();
            releaseTempDir(artifact.tempDir, tempDirRefs);
          });
        },
        cancel() {
          source.destroy();
          releaseTempDir(artifact.tempDir, tempDirRefs);
        },
      });
    },
  };
}

async function runReactNativeBundle(
  input: BuildProviderInput,
  platform: "android" | "ios",
  entryPath: string,
  bundlePath: string,
  assetsDir: string,
): Promise<void> {
  const repoRoot = resolveRepoRoot(input.workspaceRoot);
  const bundleScript = require.resolve("react-native/scripts/bundle.js", { paths: [repoRoot, process.cwd()] });
  const cliPath = require.resolve("react-native/cli.js", { paths: [repoRoot, process.cwd()] });
  const metroConfig = path.join(repoRoot, "apps", "mobile", "metro.config.js");
  const args = [
    bundleScript,
    "--platform",
    platform,
    "--dev",
    "false",
    "--entry-file",
    entryPath,
    "--bundle-output",
    bundlePath,
    "--assets-dest",
    assetsDir,
    "--config",
    metroConfig,
    "--reset-cache",
    "--config-cmd",
    `${process.execPath} ${cliPath} config`,
  ];
  await run(process.execPath, args, {
    cwd: path.join(repoRoot, "apps", "mobile"),
    env: {
      ...process.env,
      // Provider builds are one-shot bundles. Keep Metro out of watch mode so
      // local mobile smoke tests do not depend on the host inotify limit.
      CI: "1",
      NATSTACK_WORKSPACE_APP_ROOT: input.sourcePath,
    },
  });
}

function run(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr.trim()}`));
    });
  });
}

function resolveRepoRoot(workspaceRoot: string): string {
  for (const start of [process.env["NATSTACK_REPO_ROOT"], process.cwd(), workspaceRoot]) {
    if (!start) continue;
    let current = path.resolve(start);
    while (true) {
      if (
        fs.existsSync(path.join(current, "apps", "mobile", "metro.config.js")) &&
        fs.existsSync(path.join(current, "node_modules", "react-native", "cli.js"))
      ) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("Could not locate NatStack repo root for React Native provider");
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function releaseTempDir(tempDir: string, refs: Map<string, number>): void {
  const remaining = (refs.get(tempDir) ?? 1) - 1;
  if (remaining > 0) {
    refs.set(tempDir, remaining);
    return;
  }
  refs.delete(tempDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
