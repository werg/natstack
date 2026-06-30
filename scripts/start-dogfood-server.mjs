#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as YAML from "yaml";
import { printPairHelp, runPairServer } from "./cli/lib/pair-server.mjs";

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
    `Recovery: cd ${repoRoot}`,
    "Fix the rebuild/startup error, then restart:",
    "  pnpm dev:self:server",
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

export function createDogfoodPairHooks({ workspaceName }) {
  const restartTimes = [];

  return {
    beforeStart({ options, selectedHost }) {
      if (options.dev) {
        throw new Error(
          "dogfood-server always uses a persistent managed workspace; --dev is not supported"
        );
      }
      bootstrapWorkspace(workspaceName, {
        gitRemoteUrl: repoRoot,
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
        "--serve-panels",
        "--print-credentials",
        ...(options.appRoot ? ["--app-root", options.appRoot] : []),
      ];
    },
    buildEnv(baseEnv, { options, selectedHost }) {
      const dogfoodGatewayAlias = `http://${selectedHost.address}:${options.port}`;
      return {
        ...baseEnv,
        NATSTACK_DOGFOOD: "1",
        NATSTACK_DOGFOOD_SOURCE_ROOT: repoRoot,
        NATSTACK_DOGFOOD_PROJECT: projectPath,
        NATSTACK_GATEWAY_ALIASES: JSON.stringify([dogfoodGatewayAlias]),
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
      void control;
      if (!line.startsWith("[mirror] ")) return false;
      console.warn("[dogfood] Self-update mirroring is unsupported under GAD VCS; event ignored.");
      return true;
    },
    onRestartError(error) {
      printDogfoodBlock("DOGFOOD REBUILD FAILED", [
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
    portEnv: ["NATSTACK_DOGFOOD_PORT", "NATSTACK_GATEWAY_PORT", "NATSTACK_PAIR_PORT"],
    devEnv: "NATSTACK_DOGFOOD_DEV",
    restartCommand: "pnpm dev:self:server",
    usage: ["pnpm dev:self:server", "pnpm dev:self:server --port 3030"],
    startupHint:
      "[dogfood] Self-update mirroring is unsupported under GAD VCS; workspace edits stay in the managed workspace.",
    additionalHelp:
      "Dogfood mode always uses a persistent managed workspace. Set NATSTACK_DOGFOOD_WORKSPACE to change the seeded workspace name.",
    bannerTitle: "NatStack dogfood server",
    deepLinkLabel: "Pair URL",
    instructions: "Scan the QR or open the Pair URL above to pair a client over WebRTC.",
  };
  if (argv.includes("--help")) {
    printPairHelp(config);
    return;
  }
  const workspaceName = process.env.NATSTACK_DOGFOOD_WORKSPACE || "dogfood";
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
