/**
 * ServerClient TLS pinning smoke tests.
 *
 * Generates a self-signed cert with openssl, stands up a minimal HTTPS
 * WebSocket server that speaks the ws:auth handshake, and verifies that
 * fingerprint pinning in createServerClient accepts matching certs and
 * rejects mismatches.
 *
 * Skipped automatically if openssl is not on PATH.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpsServer } from "https";
import { WebSocketServer } from "ws";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { X509Certificate } from "crypto";
import { createServerClient } from "./serverClient.js";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function generateSelfSignedCert(dir: string): { certPath: string; keyPath: string; fingerprint: string } {
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "pipe" });
  const cert = new X509Certificate(fs.readFileSync(certPath));
  // X509Certificate.fingerprint256 is colon-separated uppercase hex in Node 18+.
  const fingerprint = cert.fingerprint256;
  return { certPath, keyPath, fingerprint };
}

const openssl = hasOpenssl();
const describeIf = openssl ? describe : describe.skip;

describeIf("ServerClient TLS pinning", () => {
  let tmpDir: string;
  let cert: ReturnType<typeof generateSelfSignedCert>;
  let server: ReturnType<typeof createHttpsServer>;
  let wss: WebSocketServer;
  let port: number;
  const adminToken = "test-admin-token";

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-tls-test-"));
    cert = generateSelfSignedCert(tmpDir);

    server = createHttpsServer({
      cert: fs.readFileSync(cert.certPath),
      key: fs.readFileSync(cert.keyPath),
    });
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/rpc") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === "ws:auth") {
              const success = msg.token === adminToken;
              ws.send(JSON.stringify({
                type: "ws:auth-result",
                success,
                error: success ? undefined : "bad token",
              }));
            }
          });
        });
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    wss?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("connects when fingerprint matches", async () => {
    const client = await createServerClient(port, adminToken, {
      wsUrl: `wss://127.0.0.1:${port}/rpc`,
      tls: { fingerprint: cert.fingerprint },
    });
    expect(client.isConnected()).toBe(true);
    await client.close();
  });

  it("rejects when fingerprint does not match", async () => {
    const bogus = "AB:" + "00:".repeat(30) + "FF";
    await expect(
      createServerClient(port, adminToken, {
        wsUrl: `wss://127.0.0.1:${port}/rpc`,
        tls: { fingerprint: bogus },
      }),
    ).rejects.toThrow(/fingerprint/i);
  });

  it("connects when caPath points at the cert", async () => {
    const client = await createServerClient(port, adminToken, {
      wsUrl: `wss://127.0.0.1:${port}/rpc`,
      tls: { caPath: cert.certPath },
    });
    expect(client.isConnected()).toBe(true);
    await client.close();
  });

  it("does not send the HTTP upgrade request when fingerprint mismatches", async () => {
    // Stand up a second self-signed TLS server that RECORDS every byte it
    // receives on its accepted connection. Point the client at it with the
    // FIRST cert's fingerprint pinned — the certs don't match, so the
    // client should destroy the socket on `secureConnect` and no app-layer
    // bytes (i.e. no `GET /rpc Upgrade: websocket` line) should ever appear.
    const otherCert = generateSelfSignedCert(tmpDir);
    const received: Buffer[] = [];
    const probeServer = createHttpsServer({
      cert: fs.readFileSync(otherCert.certPath),
      key: fs.readFileSync(otherCert.keyPath),
    });
    probeServer.on("connection", (raw) => {
      raw.on("data", (chunk) => { received.push(chunk); });
    });
    const probePort: number = await new Promise((resolve) => {
      probeServer.listen(0, "127.0.0.1", () => {
        resolve((probeServer.address() as { port: number }).port);
      });
    });

    try {
      await expect(
        createServerClient(probePort, adminToken, {
          wsUrl: `wss://127.0.0.1:${probePort}/rpc`,
          // Pin the ORIGINAL cert's fingerprint against the server that serves
          // the OTHER cert → guaranteed mismatch.
          tls: { fingerprint: cert.fingerprint },
        }),
      ).rejects.toThrow(/fingerprint/i);

      // Give any in-flight bytes a chance to land. The TLS layer itself
      // sends bytes during the handshake (ClientHello etc.), which are
      // captured at the "connection" event *before* TLS decryption — so
      // we'll see those. What MUST NOT be in `received` is any plaintext
      // HTTP upgrade framing, because that would imply we wrote
      // `ws:auth` or anything else after handshake completion.
      await new Promise((r) => setTimeout(r, 50));

      // TLS records (content-type byte 0x14/0x16/0x17 for CCS/Handshake/
      // App-data). Reading the combined buffer as UTF-8 should not contain
      // literal plaintext like "GET /rpc" or "Upgrade: websocket" — the
      // upgrade line would only appear if it survived the TLS layer, which
      // it won't on a sane TLS impl. Assert against substrings that would
      // signal a regression where the HTTP upgrade leaked.
      const concatenated = Buffer.concat(received).toString("binary");
      expect(concatenated).not.toContain("GET /rpc");
      expect(concatenated).not.toContain("Upgrade: websocket");
      expect(concatenated).not.toContain(adminToken);
    } finally {
      await new Promise<void>((resolve) => probeServer.close(() => resolve()));
    }
  });
});
