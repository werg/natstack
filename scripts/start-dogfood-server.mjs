#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as YAML from "yaml";
import { printPairHelp, runPairServer } from "./pair-server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectPath = process.env.NATSTACK_DOGFOOD_PROJECT || "projects/natstack";

export function platformDefault() {
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "natstack");
    case "darwin":
      return path.join(home, "Library", "Application Support", "natstack");
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "natstack");
  }
}

export function workspaceDir(name) {
  return path.join(platformDefault(), "workspaces", name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail =
      result.stderr?.trim() || result.stdout?.trim() || `${command} exited ${result.status}`;
    throw new Error(detail);
  }
  return result.stdout ?? "";
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
    ...options,
  });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

function copyWorkspaceTemplate(wsDir) {
  const sourceRoot = path.join(wsDir, "source");
  const candidates = [
    path.join(repoRoot, "workspace-template"),
    path.join(repoRoot, "resources", "workspace-template"),
    path.join(repoRoot, "workspace"),
  ];
  const templateDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "meta", "natstack.yml"))
  );
  if (!templateDir) {
    throw new Error(`Workspace template not found under ${repoRoot}`);
  }

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.cpSync(templateDir, sourceRoot, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== ".git" && name !== "node_modules" && name !== ".cache";
    },
  });
  fs.mkdirSync(path.join(sourceRoot, "projects"), { recursive: true });
  fs.mkdirSync(path.join(wsDir, "state"), { recursive: true });
}

function registerWorkspace(name) {
  const configDir = platformDefault();
  const dataPath = path.join(configDir, "data.json");
  let data = { workspaces: [] };
  if (fs.existsSync(dataPath)) {
    try {
      data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    } catch {
      data = { workspaces: [] };
    }
  }
  if (!Array.isArray(data.workspaces)) data.workspaces = [];
  data.workspaces = data.workspaces.filter((entry) => entry?.name !== name);
  data.workspaces.unshift({ name, lastOpened: Date.now() });
  fs.mkdirSync(configDir, { recursive: true });
  const tmpPath = `${dataPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, dataPath);
}

function currentBranch(cwd) {
  const branch = tryRun("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  return branch && branch !== "HEAD" ? branch : "main";
}

function syncExistingProjectClone(projectDir) {
  const status = tryRun("git", ["-C", projectDir, "status", "--porcelain"])?.trim();
  if (status) {
    printDogfoodBlock("DOGFOOD PROJECT DIRTY - startup sync skipped", status.split("\n"));
    return;
  }

  const branch = currentBranch(repoRoot);
  run("git", ["-C", projectDir, "fetch", repoRoot, branch]);
  const canFastForward = spawnSync(
    "git",
    ["-C", projectDir, "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
    {
      cwd: repoRoot,
      stdio: "ignore",
    }
  );
  if (canFastForward.status === 0) {
    run("git", ["-C", projectDir, "merge", "--ff-only", "FETCH_HEAD"]);
    return;
  }
  printDogfoodBlock("DOGFOOD PROJECT DIVERGED - startup sync skipped", [
    `Project: ${projectDir}`,
    `Source: ${repoRoot}`,
    "Resolve manually inside the dogfood project before expecting fast-forward host propagation.",
  ]);
}

function setProjectOrigin(projectDir, remoteUrl) {
  if (!remoteUrl) return;
  const existing = tryRun("git", ["-C", projectDir, "remote", "get-url", "origin"])?.trim();
  if (existing) {
    run("git", ["-C", projectDir, "remote", "set-url", "origin", remoteUrl]);
  } else {
    run("git", ["-C", projectDir, "remote", "add", "origin", remoteUrl]);
  }
}

function writeDogfoodRemoteConfig(wsDir, remoteUrl) {
  if (!remoteUrl) return;
  const [section, ...repoParts] = projectPath.split("/");
  const repoKey = repoParts.join("/");
  if (!section || !repoKey) {
    throw new Error(`Invalid dogfood project path: ${projectPath}`);
  }
  const configPath = path.join(wsDir, "source", "meta", "natstack.yml");
  const config = YAML.parse(fs.readFileSync(configPath, "utf8")) ?? {};
  config.git ??= {};
  config.git.remotes ??= {};
  config.git.remotes[section] ??= {};
  config.git.remotes[section][repoKey] ??= {};
  config.git.remotes[section][repoKey].origin = remoteUrl;
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, YAML.stringify(config), "utf8");
  fs.renameSync(tmpPath, configPath);
}

export function bootstrapWorkspace(name, opts = {}) {
  const wsDir = workspaceDir(name);
  const configPath = path.join(wsDir, "source", "meta", "natstack.yml");
  if (!fs.existsSync(configPath)) {
    console.log(`[dogfood] Creating workspace "${name}" at ${wsDir}`);
    copyWorkspaceTemplate(wsDir);
  }
  registerWorkspace(name);

  const projectDir = path.join(wsDir, "source", projectPath);
  if (fs.existsSync(projectDir)) {
    if (!fs.existsSync(path.join(projectDir, ".git"))) {
      throw new Error(`${projectDir} exists but is not a git repo`);
    }
    syncExistingProjectClone(projectDir);
  } else {
    fs.mkdirSync(path.dirname(projectDir), { recursive: true });
    console.log(`[dogfood] Cloning ${repoRoot} -> ${projectDir}`);
    run("git", ["clone", "--local", repoRoot, projectDir], { stdio: "inherit" });
  }
  setProjectOrigin(projectDir, opts.gitRemoteUrl);
  writeDogfoodRemoteConfig(wsDir, opts.gitRemoteUrl);
  run("git", ["-C", projectDir, "config", "receive.denyCurrentBranch", "ignore"]);

  const metaPath = path.join(wsDir, "source", "meta", "dogfood.json");
  fs.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: projectPath,
        sourceRoot: repoRoot,
        gitRemoteUrl: opts.gitRemoteUrl ?? null,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return wsDir;
}

function printDirtyWarning() {
  const dirty = run("git", ["-C", repoRoot, "status", "--porcelain"]).trim();
  if (!dirty) return;
  printDogfoodBlock("HOST DIRTY - dogfood propagation will be refused", dirty.split("\n"));
}

export function shouldRestart(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  return changedPaths.some((changedPath) => {
    if (typeof changedPath !== "string") return true;
    if (/^README/.test(changedPath)) return false;
    if (changedPath.endsWith(".md")) return false;
    if (changedPath.startsWith("docs/")) return false;
    if (changedPath.startsWith("apps/mobile/")) return false;
    if (changedPath.startsWith("src/main/")) return false;
    if (changedPath.startsWith("src/preload/")) return false;
    if (changedPath.startsWith("src/renderer/")) return false;
    // Workspace sources are Build V2/userland runtime inputs, not files bundled into dist/server.mjs.
    if (changedPath.startsWith("workspace/")) return false;
    return true;
  });
}

function printDogfoodBlock(title, lines) {
  const divider = "=".repeat(72);
  console.warn(`\n${divider}`);
  console.warn(`  ${title}`);
  console.warn(divider);
  for (const line of lines) console.warn(`  ${line}`);
  console.warn(`${divider}\n`);
}

function recoveryLines(exitLabel = null) {
  return [
    ...(exitLabel ? [`Exit: ${exitLabel}`] : []),
    `Recovery: cd ${repoRoot} && git reset --hard HEAD~1 && pnpm dev:self:server`,
  ];
}

function buildServer() {
  console.log("[dogfood] Building server bundle...");
  run(process.execPath, ["build.mjs"], { stdio: "inherit" });
}

async function buildServerAsync() {
  console.log("[dogfood] Building server bundle...");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["build.mjs"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`build.mjs exited ${signal ?? code}`));
    });
    child.on("error", reject);
  });
}

function dogfoodGitUrl(options, selectedHost) {
  return `${options.protocol}://${selectedHost.address}:${options.port}/_git/${projectPath}`;
}

export function createDogfoodPairHooks({ workspaceName }) {
  let lastMirrorAt = 0;
  const restartTimes = [];
  const mirrorRestartTimes = [];

  const recordMirrorRestart = () => {
    mirrorRestartTimes.push(Date.now());
    while (mirrorRestartTimes[0] && Date.now() - mirrorRestartTimes[0] > 60_000) {
      mirrorRestartTimes.shift();
    }
    if (mirrorRestartTimes.length >= 5) {
      console.error("[dogfood] Self-update restart storm detected; stopping supervisor.");
      process.exit(1);
      return false;
    }
    return true;
  };

  return {
    beforeStart({ options, selectedHost }) {
      if (options.workspaceDir) {
        throw new Error(
          "dogfood-server uses managed workspaces; use --workspace instead of --workspace-dir"
        );
      }
      if (options.dev || options.noInit) {
        throw new Error(
          "dogfood-server always uses a persistent managed workspace; --dev and --no-init are not supported"
        );
      }
      bootstrapWorkspace(workspaceName, {
        gitRemoteUrl: dogfoodGitUrl(options, selectedHost),
      });
      printDirtyWarning();
      buildServer();
    },
    buildServerArgs(options, host) {
      return [
        "dist/server.mjs",
        "--host",
        host,
        "--gateway-port",
        String(options.port),
        "--protocol",
        options.protocol,
        "--workspace",
        workspaceName,
        "--init",
        "--serve-panels",
        "--print-credentials",
        ...(options.appRoot ? ["--app-root", options.appRoot] : []),
        ...(options.publicUrl ? ["--public-url", options.publicUrl] : []),
        ...(options.requirePublicUrl || options.host === "tailscale"
          ? ["--require-public-url"]
          : []),
        ...options.serverArgs,
      ];
    },
    buildEnv(baseEnv, { options, selectedHost }) {
      const dogfoodGatewayAlias = `${options.protocol}://${selectedHost.address}:${options.port}`;
      return {
        ...baseEnv,
        NATSTACK_DOGFOOD: "1",
        NATSTACK_DOGFOOD_SOURCE_ROOT: repoRoot,
        NATSTACK_DOGFOOD_PROJECT: projectPath,
        NATSTACK_GATEWAY_ALIASES: JSON.stringify([dogfoodGatewayAlias]),
        NATSTACK_WORKSPACE: workspaceName,
        NATSTACK_WORKSPACE_DIR: workspaceDir(workspaceName),
      };
    },
    spawnServer({ serverArgs, env }) {
      return spawn(process.execPath, serverArgs, {
        cwd: repoRoot,
        stdio: ["inherit", "pipe", "pipe"],
        env,
      });
    },
    onServerLine(line, control) {
      const mirrorMatch = line.match(/^\[mirror\] (.*)$/);
      if (!mirrorMatch) return false;
      let payload;
      try {
        payload = JSON.parse(mirrorMatch[1]);
      } catch (error) {
        console.error(
          `[dogfood] Invalid mirror event: ${error instanceof Error ? error.message : String(error)}`
        );
        return true;
      }
      if (payload.event === "applied") {
        if (shouldRestart(payload.changedPaths)) {
          if (!recordMirrorRestart()) return true;
          lastMirrorAt = Date.now();
          void control.restart(buildServerAsync);
        }
      } else if (payload.event === "skipped-dirty") {
        printDogfoodBlock("HOST DIRTY - propagation refused", payload.dirtyPaths ?? []);
      } else if (payload.event === "branch-created") {
        console.warn(
          `[dogfood] Non-fast-forward mirror; created ${payload.branch}. Host HEAD unchanged.`
        );
      } else if (payload.event === "error") {
        console.error(`[dogfood] Mirror error: ${payload.message}`);
      }
      return true;
    },
    onRestartError(error) {
      printDogfoodBlock("DOGFOOD REBUILD FAILED AFTER SELF-UPDATE", [
        error instanceof Error ? error.message : String(error),
        ...recoveryLines(),
      ]);
    },
    onChildExit({ code, signal, stderrLines = [] }) {
      const stderr = stderrLines.join("\n");
      if (/EADDRINUSE|address already in use|already in use/i.test(stderr)) {
        printDogfoodBlock("DOGFOOD SERVER PORT IS UNAVAILABLE", [
          `Gateway port is already in use.`,
          ...recoveryLines(String(signal ?? code)),
        ]);
        process.exit(code ?? 1);
        return true;
      }
      const recentMirrorExit = lastMirrorAt > 0 && Date.now() - lastMirrorAt < 30_000;
      if (recentMirrorExit && code !== 0) {
        printDogfoodBlock("DOGFOOD SERVER FAILED AFTER SELF-UPDATE", [
          ...recoveryLines(String(signal ?? code)),
        ]);
        process.exit(code ?? 1);
        return true;
      }

      restartTimes.push(Date.now());
      while (restartTimes[0] && Date.now() - restartTimes[0] > 60_000) restartTimes.shift();
      if (restartTimes.length >= 5) {
        console.error("[dogfood] Server restart storm detected; stopping supervisor.");
        process.exit(code ?? 1);
        return true;
      }
      return false;
    },
  };
}

export function runDogfoodServer(argv = process.argv.slice(2)) {
  const config = {
    commandName: "dogfood-server",
    logPrefix: "dogfood",
    hostEnv: ["NATSTACK_DOGFOOD_HOST", "NATSTACK_PAIR_HOST", "NATSTACK_MOBILE_HOST"],
    portEnv: ["NATSTACK_DOGFOOD_PORT", "NATSTACK_GATEWAY_PORT", "NATSTACK_PAIR_PORT"],
    devEnv: "NATSTACK_DOGFOOD_DEV",
    restartCommand: "pnpm dev:self:server",
    usage: [
      "pnpm dev:self:server",
      "pnpm dev:self:server --host tailscale --port 3030",
      "pnpm dev:self:server --workspace dogfood",
    ],
    startupHint:
      "[dogfood] Edits in workspace/source/projects/natstack mirror back to this checkout.",
    additionalHelp:
      "Dogfood mode always uses a persistent managed workspace. Use --workspace <name>; --workspace-dir, --dev, and --no-init are not supported.",
    bannerTitle: "NatStack dogfood server",
    deepLinkLabel: "Pair URL",
    clientCommandLabel: "Client command",
    instructions: "Scan the QR for mobile pairing, or run the client command above.",
  };
  if (argv.includes("--help")) {
    printPairHelp(config);
    return;
  }
  let workspaceName = process.env.NATSTACK_WORKSPACE || "dogfood";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" && argv[i + 1]) {
      workspaceName = argv[i + 1];
      i++;
    } else if (arg?.startsWith("--workspace=")) {
      workspaceName = arg.slice("--workspace=".length);
    }
  }
  runPairServer(config, argv, createDogfoodPairHooks({ workspaceName }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runDogfoodServer();
  } catch (error) {
    console.error(`[dogfood] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
