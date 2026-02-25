/**
 * Headless service registration — writes connection.json, native messaging
 * host script, and browser manifests on every server startup.
 *
 * All operations are idempotent file writes — safe to repeat every startup.
 * This eliminates any separate "setup-extensions" step; just starting the
 * server makes the browser extensions auto-discover the running instance.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NATIVE_HOST_NAME = "com.natstack.connector";

/**
 * Stable Chrome extension ID, derived from the key in extension/manifest.json.
 * If the user overrides via env var (e.g. for a CWS-published build), use that.
 */
const CHROME_EXTENSION_ID =
  process.env["NATSTACK_CHROME_EXTENSION_ID"] || "kkhninapeajopjnlidpbbngpjlklpdnh";

/** Firefox addon ID from extension-firefox/manifest.json gecko.id */
const FIREFOX_ADDON_ID = "natstack-panel-manager@natstack.dev";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ServicePorts {
  rpcPort: number;
  panelPort: number | null;
  gitPort: number;
  pubsubPort: number;
  adminToken: string;
}

/**
 * Register the headless service for browser extension auto-discovery.
 *
 * Writes three things:
 * 1. `connection.json` — ports + token for the running server instance
 * 2. `native-messaging-host.mjs` — Node.js native messaging host script
 * 3. Browser-specific native messaging host manifests
 *
 * @param configDir  The natstack user-data directory (e.g. ~/.config/natstack)
 * @param ports      The ports and token for the running server
 */
export function registerHeadlessService(configDir: string, ports: ServicePorts): void {
  fs.mkdirSync(configDir, { recursive: true });

  writeConnectionJson(configDir, ports);
  writeNativeHostScript(configDir);
  writeBrowserManifests(configDir);
}

// ---------------------------------------------------------------------------
// connection.json
// ---------------------------------------------------------------------------

function writeConnectionJson(configDir: string, ports: ServicePorts): void {
  const serverUrl = ports.panelPort
    ? `http://127.0.0.1:${ports.panelPort}`
    : null;

  const connection = {
    rpcPort: ports.rpcPort,
    panelPort: ports.panelPort,
    gitPort: ports.gitPort,
    pubsubPort: ports.pubsubPort,
    adminToken: ports.adminToken,
    serverUrl,
  };

  const filePath = path.join(configDir, "connection.json");
  fs.writeFileSync(filePath, JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Native messaging host script
// ---------------------------------------------------------------------------

function writeNativeHostScript(configDir: string): void {
  const scriptPath = path.join(configDir, "native-messaging-host.mjs");

  // The script reads a native messaging request from stdin, reads
  // connection.json from the same directory, and writes the response.
  const script = `#!/usr/bin/env node
/**
 * NatStack native messaging host.
 * Responds to browser extension requests with the current connection config.
 *
 * Native messaging protocol: 4-byte little-endian length prefix + JSON payload.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readMessage() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerRead = 0;
    let msgLen = -1;
    let body = Buffer.alloc(0);

    process.stdin.on("readable", function onReadable() {
      // Read the 4-byte length header
      while (headerRead < 4) {
        const chunk = process.stdin.read(4 - headerRead);
        if (chunk === null) return; // wait for more data
        chunk.copy(header, headerRead);
        headerRead += chunk.length;
      }

      if (msgLen < 0) {
        msgLen = header.readUInt32LE(0);
        if (msgLen === 0 || msgLen > 1024 * 1024) {
          reject(new Error("Invalid message length: " + msgLen));
          return;
        }
      }

      // Read body (may arrive across multiple readable events)
      while (body.length < msgLen) {
        const chunk = process.stdin.read(msgLen - body.length);
        if (chunk === null) return; // wait for more data
        body = Buffer.concat([body, chunk]);
      }

      process.stdin.removeListener("readable", onReadable);
      try {
        resolve(JSON.parse(body.toString("utf-8")));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

try {
  const request = await readMessage();

  if (request.action === "getConfig") {
    const configPath = join(__dirname, "connection.json");
    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      writeMessage({
        success: true,
        serverUrl: config.serverUrl || null,
        managementToken: config.adminToken || null,
        rpcPort: config.rpcPort,
        panelPort: config.panelPort,
        gitPort: config.gitPort,
        pubsubPort: config.pubsubPort,
      });
    } catch {
      writeMessage({ success: false, error: "connection.json not found or invalid" });
    }
  } else {
    writeMessage({ success: false, error: "Unknown action: " + request.action });
  }
} catch (err) {
  writeMessage({ success: false, error: String(err) });
}
`;

  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Browser native messaging manifests
// ---------------------------------------------------------------------------

interface ManifestTarget {
  /** Filesystem path for the manifest JSON file */
  manifestPath: string;
  /** Content of the manifest */
  manifest: object;
}

function writeBrowserManifests(configDir: string): void {
  const hostScriptPath = path.join(configDir, "native-messaging-host.mjs");
  const targets = getBrowserManifestTargets(hostScriptPath);

  for (const target of targets) {
    try {
      const dir = path.dirname(target.manifestPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        target.manifestPath,
        JSON.stringify(target.manifest, null, 2) + "\n",
      );
    } catch {
      // Browser not installed or directory not writable — skip silently
    }
  }
}

function getBrowserManifestTargets(hostScriptPath: string): ManifestTarget[] {
  const home = os.homedir();
  const platform = process.platform;
  const targets: ManifestTarget[] = [];

  const chromeManifest = {
    name: NATIVE_HOST_NAME,
    description: "NatStack headless server connector",
    path: hostScriptPath,
    type: "stdio" as const,
    allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
  };

  const firefoxManifest = {
    name: NATIVE_HOST_NAME,
    description: "NatStack headless server connector",
    path: hostScriptPath,
    type: "stdio" as const,
    allowed_extensions: [FIREFOX_ADDON_ID],
  };

  if (platform === "linux") {
    // Chrome
    targets.push({
      manifestPath: path.join(home, ".config", "google-chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      manifest: chromeManifest,
    });
    // Chromium
    targets.push({
      manifestPath: path.join(home, ".config", "chromium", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      manifest: chromeManifest,
    });
    // Firefox
    targets.push({
      manifestPath: path.join(home, ".mozilla", "native-messaging-hosts", `${NATIVE_HOST_NAME}.json`),
      manifest: firefoxManifest,
    });
  } else if (platform === "darwin") {
    // Chrome
    targets.push({
      manifestPath: path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      manifest: chromeManifest,
    });
    // Chromium
    targets.push({
      manifestPath: path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      manifest: chromeManifest,
    });
    // Firefox
    targets.push({
      manifestPath: path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      manifest: firefoxManifest,
    });
  }
  // Windows not yet supported for headless native messaging

  return targets;
}
