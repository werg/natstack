# Approvals from inside an extension

Extensions have two distinct trust boundaries:

1. **Install / update / source change** — the *elevated* approval. Granted once by the user at install time (and again on dependency updates or accepted source changes). After install, the extension has full Node access. The host does not gate individual `ctx.fs` or `node:fs` calls — that would be theatre.

2. **Shared-resource approvals** — the *userland* approval, raised by the extension via `ctx.approvals.request(...)` against the original panel/worker that triggered the call. This is for custom resources owned by the extension that are made available to other userland code. It is not a general confirmation mechanism for actions the caller or extension can already take, and it is not a security boundary against the already-installed extension.

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
}
```

The host tracks the original panel/worker in a server-side active-invocation table. Extension-to-extension calls do not inherit upstream attribution; if there is no panel/worker to ask, `ctx.approvals.request(...)` returns `{ kind: "uncallable", reason: "no-user-context" }`.

## Requesting shared-resource approval

```ts
export async function activate(ctx: ExtensionContext) {
  return {
    async sendTeamCalendarInvite(teamId: string, eventId: string) {
      const decision = await ctx.approvals.request({
        subject: { id: `hello-calendar:team:${teamId}:send-invite`, label: teamId },
        title: "Allow calendar invite sending?",
        summary: "A caller wants access to this extension's shared Team Calendar sender.",
        warning: "Only allow callers that should send invites for this team.",
        options: [
          { value: "allow", label: "Allow", tone: "primary" },
          { value: "deny", label: "Don't allow", tone: "danger" },
        ],
      });
      if (decision.kind === "uncallable") {
        const err = new Error("This extension only accepts requests from panels and workers");
        (err as NodeJS.ErrnoException).code = "ENOCALLER";
        throw err;
      }
      if (decision.kind !== "choice" || !decision.choice.startsWith("allow")) {
        const err = new Error("Denied by user");
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      }
      // ...use the extension-owned shared calendar sender...
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
{ kind: "uncallable", reason: "no-user-context" } // no panel/worker caller to ask
```

By default, the host shows scoped choices: allow once, allow this session, trust version, or deny. Positive scoped choices return `choice: "allow"` and are remembered according to the selected scope; deny returns `choice: "deny"` and is not remembered.

Pass `promptOptions: "choices"` when you need a simple allow/deny prompt, or add an `options` array for custom domain-specific choices. In that mode, the `choice` string is the selected option value. The host records it as a caller-scoped grant; subsequent same-subject requests skip the prompt.

### Subject conventions

Pick `subject.id` to scope the grant correctly:

- **Per shared resource** (`"hello-calendar:team:team-x:send-invite"`): user grants one caller access to one extension-owned resource.
- **Per operation class** (`"hello-calendar:send-invite"`): user grants one caller access to an operation across the extension's resource set.
- **Session-scoped resource**: include a per-session token only when the resource itself is session-scoped; do not include timestamps, temp paths, random ids, or per-call data unless you intentionally want every call to re-prompt.

The host doesn't impose a model — pick what matches the user's mental model of "what did I agree to."

## When *not* to prompt

`ctx.approvals.request` is for grants to extension-owned shared resources. Don't use it as a fake security layer or generic confirmation dialog — the extension is already trusted to do whatever it wants via raw Node, and the outer host/runtime permission model already protects sensitive host resources where needed.

Prompt when:
- The extension owns a shared service/resource and another panel, worker, DO, or extension asks to use it.
- NatStack has no built-in permission model for that resource.
- A remembered grant for a stable `subject.id` is meaningful to the user.

Don't prompt when:
- The caller or extension is doing ordinary filesystem, process, network, panel, git, browser, credential, or runtime work. Use the corresponding host/runtime API and let NatStack's built-in permission flow handle sensitive resources.
- The work is internal bookkeeping such as writing to `ctx.storage`, log records, health reports, cache files, scratch files, or temporary test directories.
- You're calling another extension that will do its own prompting (`extensions.use(...)` calls do not propagate upstream attribution).

## Prompt copy

The host shows a standard userland-approval card with attribution: "Panel `<callerId>` is being asked by extension `<extensionName>`." Your `title`/`summary`/`warning` text appears underneath. `details` (up to 8 `{label, value}` pairs) renders as a key-value list — useful for showing what's about to be changed.

The prompt's **default action on dismissal is deny**. Don't write code that depends on the prompt being answered in a specific time window — the user may walk away.

## Cached grants and undeclaring

Grants persist in the userland-approval grant store across host restarts.

- **Clearing grants** is only done programmatically, from a panel/worker or attributed extension: `runtime.approvals.revoke(subjectId)` / `ctx.approvals.revoke(subjectId)`.
- **Undeclaring or stopping an extension** is separate and does **not** clear grants: removing it from `extensions:` in `meta/natstack.yml` stops and removes the extension, but its grants and per-extension storage scratch are retained. Grants are namespaced by `(principal, extension)`, so re-declaring under the same name will see the same grants — revoke explicitly if you want them gone.
