#!/usr/bin/env node
// Set the root package.json version from a release tag like "v1.2.3" → "1.2.3".
// The release workflow runs this before `pnpm build` + staging so the published
// @natstack/server / @natstack/app (which read the root version) and the
// electron-builder installers all carry the tag version. Usage:
//   node scripts/set-version-from-tag.mjs "$GITHUB_REF_NAME"
import * as fs from "node:fs";
import process from "node:process";

const tag = process.argv[2] ?? process.env["GITHUB_REF_NAME"] ?? "";
const version = tag.replace(/^v/, "").trim();
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error(`Refusing to set an invalid version from tag "${tag}"`);
  process.exit(1);
}

const file = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = version;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Set root package version to ${version}`);
