export function agentLabel(kind?: string): string {
  switch (kind) {
    case "claude-code": return "Claude Code";
    case "codex": return "Codex";
    case "aider": return "Aider";
    case "opencode": return "OpenCode";
    case "test-runner": return "Tests";
    case "dev-server": return "Dev server";
    default: return "Shell";
  }
}
