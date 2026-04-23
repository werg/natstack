import type { FlowRunner } from "../resolver.js";
import { botToken } from "./botToken.js";
import { cliPiggyback } from "./cliPiggyback.js";
import { composioBridge } from "./composioBridge.js";
import { deviceCode } from "./deviceCode.js";
import { envVar } from "./envVar.js";
import { githubAppInstallation } from "./githubAppInstallation.js";
import { loopbackPkce } from "./loopbackPkce.js";
import { mcpDcr } from "./mcpDcr.js";
import { pat } from "./pat.js";
import { serviceAccount } from "./serviceAccount.js";

export const builtinFlows: Map<string, FlowRunner> = new Map([
  ["loopback-pkce", loopbackPkce],
  ["device-code", deviceCode],
  ["pat", pat],
  ["cli-piggyback", cliPiggyback],
  ["mcp-dcr", mcpDcr],
  ["composio-bridge", composioBridge],
  ["service-account", serviceAccount],
  ["bot-token", botToken],
  ["github-app-installation", githubAppInstallation],
  ["env-var", envVar],
]);

export {
  botToken,
  cliPiggyback,
  composioBridge,
  deviceCode,
  envVar,
  githubAppInstallation,
  loopbackPkce,
  mcpDcr,
  pat,
  serviceAccount,
};
