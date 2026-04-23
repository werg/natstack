import type { ProviderManifest } from "../types.js";
import { github } from "./github.js";
import { google } from "./google.js";
import { microsoft } from "./microsoft.js";
import { notion } from "./notion.js";
import { slack } from "./slack.js";

export const builtinProviders: ProviderManifest[] = [
  github,
  google,
  microsoft,
  notion,
  slack,
];

export { github, google, microsoft, notion, slack };
