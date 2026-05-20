#!/usr/bin/env node
import { runPairServer } from "./pair-server.mjs";

try {
  runPairServer({
    commandName: "pair",
    logPrefix: "pair",
    hostEnv: ["NATSTACK_PAIR_HOST", "NATSTACK_MOBILE_HOST", "NATSTACK_DEV_HOST"],
    portEnv: ["NATSTACK_PAIR_PORT", "NATSTACK_MOBILE_PORT"],
    devEnv: "NATSTACK_MOBILE_DEV",
    restartCommand: "pnpm pair",
    usage: [
      "pnpm pair",
      "pnpm pair --dev",
      "pnpm pair --host tailscale --port 3030",
      "pnpm pair --host 100.x.y.z --workspace my-workspace",
      "pnpm pair --host server.tailnet.ts.net --public-url http://server.tailnet.ts.net:3030",
    ],
    startupHint:
      "[pair] Scan with the NatStack mobile app, click the Pair URL on a laptop, or paste the pairing code.",
    bannerTitle: "Pair a NatStack device",
    deepLinkLabel: "Pair URL",
    instructions:
      "Scan with the mobile app, click the Pair URL on a laptop, or paste the code in Connection Settings.",
  });
} catch (error) {
  console.error(`[pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
