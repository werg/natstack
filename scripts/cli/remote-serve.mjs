#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "natstack remote serve",
    logPrefix: "pair",
    portEnv: ["NATSTACK_PAIR_PORT", "NATSTACK_MOBILE_PORT"],
    devEnv: "NATSTACK_MOBILE_DEV",
    usage: ["natstack remote serve", "natstack remote serve --dev", "natstack remote serve --port 3030"],
    startupHint:
      "[pair] Scan with the NatStack mobile app or paste the pairing code in Connection Settings.",
    bannerTitle: "Pair a NatStack device",
    deepLinkLabel: "Pair URL",
    instructions: "Scan with the mobile app, or paste the code in Connection Settings.",
  });
} catch (error) {
  console.error(`[pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
