#!/usr/bin/env node
import { runPairServer } from "./lib/pair-server.mjs";

try {
  runPairServer({
    commandName: "natstack mobile pair",
    logPrefix: "mobile-pair",
    hostEnv: ["NATSTACK_MOBILE_HOST", "NATSTACK_DEV_HOST"],
    portEnv: ["NATSTACK_MOBILE_PORT"],
    devEnv: "NATSTACK_MOBILE_DEV",
    restartCommand: "natstack mobile pair",
    usage: [
      "natstack mobile pair",
      "natstack mobile pair --dev",
      "natstack mobile pair --host tailscale --port 3030",
      "natstack mobile pair --host 100.x.y.z --workspace my-workspace",
      "natstack mobile pair --host server.tailnet.ts.net --public-url http://server.tailnet.ts.net:3030",
    ],
    startupHint:
      "[mobile-pair] Install the internal APK with: natstack mobile install --launch",
    bannerTitle: "NatStack Android pairing",
    instructions:
      "Open the QR code with the Android camera. NatStack will confirm and save the connection.",
  });
} catch (error) {
  console.error(`[mobile-pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
