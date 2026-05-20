import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "workspace/panels/terminal");
const outDir = path.join(root, ".tmp/terminal-input-jig-smoke");
const mainPath = path.join(outDir, "electron-main.mjs");

await fs.promises.mkdir(outDir, { recursive: true });
await fs.promises.copyFile(
  path.join(sourceDir, "inputJig.html"),
  path.join(outDir, "index.html")
);

await esbuild.build({
  entryPoints: [path.join(sourceDir, "inputJig.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: path.join(outDir, "inputJig.js"),
  loader: { ".css": "css" },
});

await fs.promises.writeFile(
  mainPath,
  `
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.dirname(fileURLToPath(import.meta.url));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await win.webContents.executeJavaScript(expression, true);
      if (value) return value;
      last = value;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for " + expression + "; last=" + String(last));
}

async function snapshot(win) {
  return win.webContents.executeJavaScript(
    "window.__terminalInputJig?.snapshot ? window.__terminalInputJig.snapshot() : null",
    true
  );
}

function keyCodeFor(char) {
  return char.length === 1 ? char.toUpperCase() : char;
}

async function run() {
  await app.whenReady();
  console.log("[jig smoke] app ready");
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error("[jig console]", message, sourceId + ":" + line);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error("[jig smoke] did-fail-load", code, desc, url);
  });
  console.log("[jig smoke] loading file");
  await win.loadFile(path.join(outDir, "index.html"));
  console.log("[jig smoke] loaded file");
  await waitFor(win, "Boolean(window.__terminalInputJig && document.querySelector('.xterm'))");
  console.log("[jig smoke] xterm ready");
  const point = await win.webContents.executeJavaScript(\`
    (() => {
      const node = document.querySelector('.xterm');
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  \`, true);
  win.webContents.focus();
  console.log("[jig smoke] clicking terminal", point);
  win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await delay(100);
  console.log("[jig smoke] after click", JSON.stringify(await snapshot(win)));
  for (const char of "abc") {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: keyCodeFor(char) });
    win.webContents.sendInputEvent({ type: "char", keyCode: char });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: keyCodeFor(char) });
  }
  console.log("[jig smoke] sent input");
  try {
    const finalSnapshot = await waitFor(
      win,
      "window.__terminalInputJig.snapshot().writes.join('').includes('abc') && window.__terminalInputJig.snapshot()",
      5000
    );
    console.log(JSON.stringify(finalSnapshot, null, 2));
  } catch (err) {
    console.error("[jig smoke] final snapshot", JSON.stringify(await snapshot(win), null, 2));
    throw err;
  }
  await app.quit();
}

run().catch(async (err) => {
  console.error(err);
  await app.quit();
  process.exit(1);
});
`,
  "utf8"
);

const electron = require("electron");
const child = spawn(electron, [mainPath], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

const code = await new Promise((resolve) => child.on("exit", resolve));
process.exit(code ?? 1);
