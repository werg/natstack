import { app } from "electron";
import * as path from "path";
import { type ConnectPairing, parseConnectLink } from "@natstack/shared/connect";

/** The WebRTC pairing material carried by a `natstack://connect` deep link. */
export type PendingConnectLink = ConnectPairing;

let pending: PendingConnectLink | null = null;
const listeners = new Set<(link: PendingConnectLink) => void>();

export function registerProtocol(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("natstack");
    return;
  }
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  app.setAsDefaultProtocolClient("natstack", process.execPath, entry ? [entry] : []);
}

export function installEarlyOpenUrlBuffer(): void {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    enqueueConnectLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    enqueueFirstArgvLink(argv);
  });
}

export function enqueueFirstArgvLink(argv: readonly string[]): void {
  const raw = argv.find((arg) => typeof arg === "string" && arg.startsWith("natstack://"));
  if (raw) enqueueConnectLink(raw);
}

export function enqueueConnectLink(raw: string): void {
  const parsed = parseConnectLink(raw);
  if (parsed.kind === "error") return;
  const { kind: _kind, ...link } = parsed;
  pending = link;
  for (const listener of listeners) listener(link);
}

export function getPendingConnectLink(): PendingConnectLink | null {
  const link = pending;
  pending = null;
  return link;
}

export function onConnectLink(listener: (link: PendingConnectLink) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
