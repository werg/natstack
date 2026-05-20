import { createHash } from "node:crypto";
import type { UserlandApprovalRequest } from "@natstack/extension";

const options = [
  { value: "allow", label: "Allow", tone: "primary" as const },
  { value: "deny", label: "Deny", tone: "danger" as const },
];

function digest(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 48);
}

export function buildExecApproval(req: {
  command: string;
  args: string[];
  cwd: string;
  shell: boolean;
}): UserlandApprovalRequest {
  const argv = [req.command, ...req.args];
  return {
    subject: {
      id: `user.exec.${digest([req.command, ...req.args, req.cwd, req.shell ? "sh" : "argv"])}`,
      label: argv.join(" "),
    },
    title: "Run command",
    summary: argv.join(" "),
    warning: req.shell ? "Runs through /bin/sh -c; shell metacharacters will be interpreted." : undefined,
    details: [
      { label: "Command", value: argv.join(" ") },
      { label: "Directory", value: req.cwd },
      { label: "Mode", value: req.shell ? "shell" : "argv" },
    ],
    options,
  };
}

export function buildOpenApproval(req: {
  command: string;
  args: string[];
  cwd: string;
  label?: string;
}): UserlandApprovalRequest {
  const argv = [req.command, ...req.args];
  return {
    subject: {
      id: `user.open.${digest([req.command, ...req.args, req.cwd])}`,
      label: req.label ?? argv.join(" "),
    },
    title: "Open terminal session",
    summary: req.label ?? argv.join(" "),
    details: [
      { label: "Command", value: argv.join(" ") },
      { label: "Directory", value: req.cwd },
    ],
    options,
  };
}

export function buildUrlOpenApproval(req: { url: string }): UserlandApprovalRequest {
  const parsed = new URL(req.url);
  return {
    subject: {
      id: `user.open-url.${digest([parsed.origin])}`,
      label: parsed.origin,
    },
    title: "Open URL",
    summary: req.url,
    details: [
      { label: "URL", value: req.url },
      { label: "Origin", value: parsed.origin },
    ],
    options,
  };
}
