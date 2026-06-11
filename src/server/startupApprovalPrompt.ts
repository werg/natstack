import * as readline from "node:readline/promises";
import { stdin, stderr } from "node:process";

import type { UnitBatchEntry } from "@natstack/shared/approvals";
import type { StartupUnitApprovalPrompt } from "./unitApprovalCoordinator.js";

export function createTerminalStartupApprovalPrompt(): StartupUnitApprovalPrompt {
  return {
    async request(req) {
      if (!stdin.isTTY) {
        stderr.write(
          "\n[StartupApproval] Cannot prompt for workspace unit approval because stdin is not a TTY.\n"
        );
        return "deny";
      }
      stderr.write(formatStartupApprovalRequest(req.title, req.description, req.units));
      const rl = readline.createInterface({ input: stdin, output: stderr });
      try {
        for (;;) {
          const answer = (await rl.question("Approve these workspace units? [y/N] ")).trim();
          if (/^(y|yes|a|approve)$/i.test(answer)) return "once";
          if (answer === "" || /^(n|no|d|deny)$/i.test(answer)) return "deny";
          stderr.write("Please answer y or n.\n");
        }
      } finally {
        rl.close();
      }
    },
  };
}

function formatStartupApprovalRequest(
  title: string,
  description: string,
  units: readonly UnitBatchEntry[]
): string {
  const lines = ["", "=".repeat(72), `  ${title}`, "=".repeat(72), description, ""];
  for (const unit of units) {
    lines.push(`  - ${formatUnit(unit)}`);
  }
  lines.push(
    "",
    "Approving builds and activates these workspace-owned units before pairing is shown.",
    "Denying leaves them pending for a later shell approval.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function formatUnit(unit: UnitBatchEntry): string {
  const parts = [
    unit.displayName || unit.unitName,
    `kind=${unit.unitKind}`,
    unit.target ? `target=${unit.target}` : null,
    `source=${unit.source.repo}@${unit.source.ref}`,
    unit.ev ? `ev=${unit.ev}` : null,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join("  ");
}
