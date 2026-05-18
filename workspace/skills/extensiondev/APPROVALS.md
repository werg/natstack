# Approvals from inside an extension

Extensions have two distinct trust boundaries:

1. **Install / update / source-push** — the *elevated* approval. Granted once by the user at install time (and again on dependency updates or accepted source pushes). After install, the extension has full Node access. The host does not gate individual `ctx.fs` or `node:fs` calls — that would be theatre.

2. **Per-call approvals** — the *userland* approval, raised by the extension via `ctx.approvals.requestForCaller(...)` against the original panel/worker that triggered the call. This is a **user-intent** mechanism, not a security boundary against the already-installed extension. Use it when the user should explicitly authorize an action the extension is about to take on their behalf.

This doc is about the second.

## The invocation envelope

Every inbound method call carries an `ExtensionInvocation` that the host stamps. Extension code reads it from `AsyncLocalStorage` via `ctx.invocation.current()`:

```ts
interface ExtensionInvocation {
  requestId: string;
  extensionName: string;
  method: string;
  caller: {
    callerId: string;
    callerKind: "panel" | "worker" | "shell" | "extension" | "http";
    connectionId?: string;
  };
  // Only present when the immediate caller is a panel/worker. This is the
  // principal `requestForCaller` asks. Extension-to-extension calls do NOT
  // inherit upstream userland identity; if you need to ask, ask upstream
  // before delegating.
  userlandCaller?: {
    callerId: string;
    callerKind: "panel" | "worker";
    repoPath: string;
    effectiveVersion: string;
  };
}
```

`userlandCaller` is what `requestForCaller` operates on. If you're called from another extension, `userlandCaller` is `undefined` and `requestForCaller` will throw `ENOCALLER`.

## Requesting per-call approval

```ts
export async function activate(ctx: ExtensionContext) {
  return {
    async deleteWorkspace(target: string) {
      const inv = ctx.invocation.current();
      if (!inv?.userlandCaller) {
        // Called by another extension or by a non-userland caller — refuse
        // rather than silently auto-allowing (the user has no chance to
        // intervene). Upstream callers should have prompted.
        const err = new Error("This extension only accepts requests from panels and workers");
        (err as NodeJS.ErrnoException).code = "ENOCALLER";
        throw err;
      }
      const decision = await ctx.approvals.requestForCaller({
        subject: { id: `hello:delete:${target}`, label: target },
        title: `Allow Hello to delete ${target}?`,
        summary: `Requested by ${inv.userlandCaller.callerId}.`,
        warning: "This permanently removes the workspace and its contexts.",
        options: [
          { value: "allow", label: "Allow this once", tone: "primary" },
          { value: "allow-session", label: "Allow for this session" },
          { value: "deny", label: "Don't allow", tone: "danger" },
        ],
      });
      if (decision.kind !== "choice" || !decision.choice.startsWith("allow")) {
        const err = new Error("Denied by user");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      // ...perform the work...
    },
  };
}
```

### Request shape

The `subject` is the **durable key** for grant lookup. The host stores grants keyed by `(principal.callerId, issuer={kind:"extension", id:extensionName}, subject.id)`. The next time the same panel calls into the same extension with the same `subject.id`, the host returns the saved choice instead of re-prompting.

- `subject.id` must be `[A-Za-z0-9._:/-]+`, 1–128 chars, and must not start with a reserved prefix (`shell:`, `server:`, `system:`, `@`).
- `title`, `summary`, `warning`, `details[].value` are length-capped and stripped of control characters. The host re-validates the request before showing it; an invalid request throws `EINVAL` *before* the prompt fires.
- `options` are 1–6, each with a unique `value` of `[A-Za-z0-9_-]+`. The reserved `dismiss` value is not allowed — dismissal is handled by the host and collapses to `deny`.

### Choice handling

The returned `UserlandApprovalChoice` is either:

```ts
{ kind: "choice", choice: string }    // user picked one of your options
{ kind: "dismissed" }                  // user closed the prompt → treat as deny
```

The `choice` string is whatever option `value` you defined. The host records it as a grant; subsequent same-subject requests skip the prompt.

### Subject conventions

Pick `subject.id` to scope the grant correctly:

- **Per-resource** (`"hello:read:/etc/hosts"`): user grants access to one file. The next request for a different path re-prompts.
- **Per-action** (`"hello:delete"`): user grants the action category. All future deletes auto-grant.
- **Session-scoped feel**: include a per-session token in the id (`"hello:delete:${sessionId}"`); the grant survives only as long as the session id stays the same.

The host doesn't impose a model — pick what matches the user's mental model of "what did I agree to."

## When *not* to prompt

`requestForCaller` is for **user intent**, not access control. Don't use it as a fake security layer — the extension is already trusted to do whatever it wants via raw Node.

Prompt when:
- The action has user-visible side effects (deleting data, sending a message, spending credits).
- The action consumes user-owned credentials (and the credential system itself isn't already prompting).
- The user might reasonably want to confirm a destructive or expensive operation per call.

Don't prompt when:
- The call is read-only metadata that the user already authorized by calling the extension at all.
- The work is internal bookkeeping (writing to `ctx.storage`, log records, health reports).
- You're calling another extension that will do its own prompting (`extensions.use(...)` calls don't propagate `userlandCaller`).

## Prompt copy

The host shows a standard userland-approval card with attribution: "Panel `<callerId>` is being asked by extension `<extensionName>`." Your `title`/`summary`/`warning` text appears underneath. `details` (up to 8 `{label, value}` pairs) renders as a key-value list — useful for showing what's about to be changed.

The prompt's **default action on dismissal is deny**. Don't write code that depends on the prompt being answered in a specific time window — the user may walk away.

## Cached grants and `setEnabled`

Grants persist in the userland-approval grant store across host restarts. Two ways to clear:

- **Programmatically** from a panel/worker: `requestApproval`/`revokeApproval` from `@workspace/runtime`. The extension cannot revoke a grant it issued (asymmetric on purpose — only the principal can revoke).
- **By disabling the extension**: `extensions.setEnabled(name, false)` doesn't clear grants by itself. `extensions.uninstall(name, { purge: true })` removes the storage scratch but not the grants. Grants are namespaced by `(principal, extension)`, so reinstalling the extension under the same name will see the same grants.
