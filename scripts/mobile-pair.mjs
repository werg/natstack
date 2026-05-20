#!/usr/bin/env node
import { runPairServer } from "./pair-server.mjs";

try {
  runPairServer({
    commandName: "mobile-pair",
    logPrefix: "mobile-pair",
    hostEnv: ["NATSTACK_MOBILE_HOST", "NATSTACK_DEV_HOST"],
    portEnv: ["NATSTACK_MOBILE_PORT"],
    devEnv: "NATSTACK_MOBILE_DEV",
    restartCommand: "pnpm mobile:pair",
    usage: [
      "pnpm mobile:pair",
      "pnpm mobile:pair --dev",
      "pnpm mobile:pair --host tailscale --port 3030",
      "pnpm mobile:pair --host 100.x.y.z --workspace my-workspace",
      "pnpm mobile:pair --host server.tailnet.ts.net --public-url http://server.tailnet.ts.net:3030",
    ],
    startupHint:
      "[mobile-pair] Install the internal APK with: pnpm mobile:install:internal --launch",
    bannerTitle: "NatStack Android pairing",
    instructions:
      "Open the QR code with the Android camera. NatStack will confirm and save the connection.",
  });
} catch (error) {
  console.error(`[mobile-pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
