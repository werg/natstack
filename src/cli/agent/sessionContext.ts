import { loadCliCredentials } from "../credentialStore.js";
import { RpcClient } from "../rpcClient.js";
import { isValidSessionName, loadAgentSession, type AgentSession } from "../sessionStore.js";
import { AuthError, CliError, StaleSessionError, UsageError } from "../output.js";
import type { FlagSpec, ParsedInvocation } from "../commandTable.js";

/**
 * Session scoping shared by the fs/git command groups: every command targets
 * the context folder of an attached agent session (`--session NAME`, default
 * "default") and dispatches via the paired device credential.
 */

export const DEFAULT_SESSION = "default";

/** Common --session flag for context-scoped commands. */
export const SESSION_FLAG: FlagSpec = {
  name: "session",
  takesValue: true,
  description: `Agent session name (default: "${DEFAULT_SESSION}")`,
};

export interface SessionScope {
  client: RpcClient;
  contextId: string;
  session: AgentSession;
}

/** Resolve the RPC client + contextId for the invocation's --session flag. */
export function resolveSessionScope(inv: ParsedInvocation): SessionScope {
  const name = typeof inv.flags["session"] === "string" ? inv.flags["session"] : DEFAULT_SESSION;
  if (!isValidSessionName(name)) {
    throw new UsageError(`Invalid session name: ${name} (use letters, digits, "_", "-")`);
  }
  const session = loadAgentSession(name);
  if (!session) {
    throw new CliError(`no session named ${name} — run \`natstack agent attach ${name}\` first`);
  }
  const creds = loadCliCredentials();
  if (!creds) {
    throw new AuthError('not paired — run `natstack remote pair "natstack://connect?..."` first');
  }
  if (!creds.workspaceName) {
    throw new AuthError("no remote workspace selected — run `natstack remote select <workspace>`");
  }
  if (session.serverUrl !== creds.url) {
    throw new StaleSessionError(
      `session ${name} was created for ${session.serverUrl}, but the stored credential targets ${creds.url}`
    );
  }
  return { client: new RpcClient(creds), contextId: session.contextId, session };
}
