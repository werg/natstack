import { anthropic } from "./anthropic.js";
import type { ProviderManifest } from "../types.js";
import { github } from "./github.js";
import { google } from "./google.js";
import { googleWorkspace } from "./google-workspace.js";
import { microsoft } from "./microsoft.js";
import { mistral } from "./mistral.js";
import { notion } from "./notion.js";
import { openai } from "./openai.js";
import { openaiCodex } from "./openai-codex.js";
import { openrouter } from "./openrouter.js";
import { groq } from "./groq.js";
import { slack } from "./slack.js";

export const builtinProviders: ProviderManifest[] = [
  anthropic,
  github,
  google,
  googleWorkspace,
  groq,
  microsoft,
  mistral,
  notion,
  openai,
  openaiCodex,
  openrouter,
  slack,
];

export {
  anthropic,
  github,
  google,
  googleWorkspace,
  groq,
  microsoft,
  mistral,
  notion,
  openai,
  openaiCodex,
  openrouter,
  slack,
};
