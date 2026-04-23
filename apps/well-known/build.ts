import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Config {
  apple: {
    teamId: string;
    bundleId: string;
  };
  android: {
    packageName: string;
    sha256CertFingerprints: string[];
  };
}

const rootDir = __dirname;
const srcDir = path.join(rootDir, "src");
const distDir = path.join(rootDir, "dist", ".well-known");

const config = JSON.parse(
  readFileSync(path.join(rootDir, "config.json"), "utf8"),
) as Config;

function applyReplacements(
  template: string,
  replacements: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return replacements[key] ?? match;
  });
}

const appleTemplate = readFileSync(
  path.join(srcDir, "apple-app-site-association.template.json"),
  "utf8",
);
const assetlinksTemplate = readFileSync(
  path.join(srcDir, "assetlinks.template.json"),
  "utf8",
);

const appleOutput = applyReplacements(appleTemplate, {
  teamId: config.apple.teamId,
  bundleId: config.apple.bundleId,
});

const assetlinksOutput = applyReplacements(assetlinksTemplate, {
  packageName: config.android.packageName,
  sha256CertFingerprints: JSON.stringify(
    config.android.sha256CertFingerprints,
  ),
});

mkdirSync(distDir, { recursive: true });

writeFileSync(
  path.join(distDir, "apple-app-site-association"),
  appleOutput,
  "utf8",
);
writeFileSync(path.join(distDir, "assetlinks.json"), assetlinksOutput, "utf8");
