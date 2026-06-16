#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "natstack remote serve",
    logPrefix: "pair",
    hostEnv: ["NATSTACK_PAIR_HOST", "NATSTACK_MOBILE_HOST", "NATSTACK_DEV_HOST"],
    portEnv: ["NATSTACK_PAIR_PORT", "NATSTACK_MOBILE_PORT"],
    devEnv: "NATSTACK_MOBILE_DEV",
    restartCommand: "natstack remote serve",
    usage: [
      "natstack remote serve",
      "natstack remote serve --dev",
      "natstack remote serve --host tailscale --port 3030",
      "natstack remote serve --host 100.x.y.z --workspace my-workspace",
      "natstack remote serve --host server.tailnet.ts.net --public-url http://server.tailnet.ts.net:3030",
    ],
    startupHint:
      "[pair] Scan with the NatStack mobile app, click the Pair URL on a laptop, or paste the pairing code.",
    bannerTitle: "Pair a NatStack device",
    deepLinkLabel: "Pair URL",
    clientCommandLabel: "Desktop command",
    instructions:
      "Scan with the mobile app, run the desktop command on a laptop, or paste the code in Connection Settings.",
  });
} catch (error) {
  console.error(`[pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
