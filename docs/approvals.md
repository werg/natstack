# Approvals

NatStack approval prompts use one server-owned queue and two shell surfaces:
Electron and mobile. The queue is the source of truth; notifications are a
delivery surface for pending queue entries.

Approval kinds:

- `credential` and `capability`: host-owned reusable grants with standard
  trust scopes.
- `client-config` and `credential-input`: trusted shell input flows for
  secrets and provider setup.
- `userland`: panel/worker-owned prompts with provider-defined options and a
  flat persisted decision keyed by verified issuer and provider subject.

## Architecture

```text
panel / worker
    |
    | approval request
    v
approvalQueue
    |
    | pending changed
    v
approvalPushBridge --------------------.
    |                                   |
    | sendBatch / cancel                | listPending / resolve
    v                                   |
pushService                            shellApprovalService
    |
    | Firebase Admin SDK
    v
FCM / APNs
    |
    | approval-prompt / approval-cancel
    v
mobile messaging + Notifee
    |
    | action press, queued if backgrounded
    v
mobile shell transport
    |
    '---- shellApproval.resolve / submit / resolveUserland
```

The bridge sends push notifications for newly pending approvals and sends a
silent `approval-cancel` message when the queue entry resolves elsewhere.
Desktop heartbeat suppresses mobile pushes for a short window while an active
Electron approval bar is present.

## Firebase Provisioning

1. Create or select a Firebase project.
2. Enable Firebase Cloud Messaging for the project.
3. Generate a Firebase service account JSON file for the server.
4. Set one of these on the server:
   - `NATSTACK_FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/firebase-service-account.json`
   - `NATSTACK_FIREBASE_SERVICE_ACCOUNT_JSON='<json>'`
   - `GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-service-account.json`
5. For Android, copy `apps/mobile/android/app/google-services.template.json` to
   `apps/mobile/android/app/google-services.json` and replace it with the real
   project config. The Gradle plugin is applied only when this file exists.
6. For iOS, add an APNs auth key or certificate in Firebase, then copy
   `apps/mobile/ios/NatStack/GoogleService-Info.template.plist` to
   `apps/mobile/ios/NatStack/GoogleService-Info.plist` and replace it with the
   real project config.
7. Build and run the mobile app once so it can register its FCM token through
   the `push.register` RPC.

If Firebase credentials are missing on the server, push delivery degrades to
log-only mode. The in-app approval sheet still works.

## Decision Matrix

| Decision | Notification action | Meaning |
| --- | --- | --- |
| `once` | Once | Approve this pending operation only. No reusable grant is stored. |
| `session` | Session | Approve matching requests for the current process session. |
| `version` | Trust Version | Approve matching requests from the same effective code version. |
| `repo` | Trust Repo | Approve matching requests from the same repository scope. |
| `deny` | Deny | Reject the request. |
| `dismiss` | Sheet close only | Treat as deny without presenting it as an affirmative denial action. |
| `open` | Open | Open the mobile app to the approval sheet. It does not resolve by itself. |

Standard `credential` and `capability` approvals expose `once`, `session`,
`deny`, `open`, `version`, and `repo` in that order. `client-config`,
`credential-input`, and `userland` approvals expose only `open` from the
notification because they require in-app UI.

## Userland Approval Flow

Userland code calls `requestApproval()` from `@workspace/runtime` (panel) or
`runtime.requestApproval()` from a worker runtime. The request supplies a
provider-owned `subject.id`, user-facing copy, and 1-6 option buttons. The
server ignores any caller identity in the payload; it uses `ServiceContext` and
`CodeIdentityResolver` to attach the verified panel/worker issuer.

The service checks the persisted grant store before showing the prompt. A grant
hit returns `{ kind: "choice", choice }` immediately. If there is no grant, the
approval queue shows one prompt per `(issuer.callerId, subject.id)` and
coalesces concurrent waiters. When the user chooses an option, the choice is
persisted under that flat key. Dismissals return `{ kind: "dismissed" }` and
are not persisted.

Userland prompt copy is untrusted provider text. UI surfaces must keep the
verified issuer visually primary and render provider subject/details inside the
framed userland prompt area. Provider strings must never masquerade as shell,
server, or system identity.

Subject and option validation is intentionally strict:

- `subject.id`: 1-128 chars, letters/numbers/`._:/-`, no control characters,
  and not prefixed with `shell:`, `server:`, `system:`, or `@`.
- option values: unique, 1-40 chars, letters/numbers/`_-`; `dismiss` is
  reserved.
- title, summary, warning, details, labels, and descriptions are length-bound
  and stripped/rejected for invisible/control characters before enqueueing.

Revocation is issuer-scoped: `revokeApproval(subjectId)` can only remove grants
owned by the calling panel or worker. `listApprovals()` returns only grants for
that issuer.

## Security Model

The server queue is authoritative. Mobile notification actions only call the
same `shellApproval` RPC methods used by the Electron shell, and stale or
already-resolved approvals are ignored server-side.

Secret-input flows cannot be resolved from notification actions. FCM data
payloads are size-limited, pass through third-party infrastructure, and are not
an appropriate transport for client secrets, API keys, or provider-supplied
dynamic option values. These flows use an `Open` notification that foregrounds
the app and renders the in-app approval sheet.

Lock-screen actions are intentionally limited to decisions that do not require
entering or displaying secrets. Device lock, OS notification permissions, the
existing shell authentication flow, and server-side idempotency form the
security boundary.

Biometric locking was removed as an explicit product decision. NatStack is not
a banking app; the device lock screen plus the existing authenticated shell
connection are considered sufficient. Re-adding biometric gating would require
restoring the deleted biometric files and reintroducing the app-level gate in
`apps/mobile/App.tsx`.

## Limitations

- User force-quit suppresses background FCM handling on iOS and most Android
  builds until the app is opened again.
- Aggressive Android battery savers can delay or drop FCM. Exempt NatStack from
  battery optimization for reliable background approval delivery.
- Mobile must foreground at least once for queued background actions to drain to
  the server. Until then, actioned notifications show a syncing state.
- FCM data payloads have a 4 KB limit. Notification copy is intentionally short;
  full approval details live in the queue and in-app sheet.
- iOS shows only the first few actions inline depending on notification
  presentation. Touch-and-Hold reveals the rest. Android exposes all actions
  when the notification is expanded.
- iOS Notification Service Extension support is deferred. Current notifications
  are sufficient for action buttons but do not support rich attachments or
  payload mutation on device.

## Native Testing

Real device testing is required for FCM/APNs behavior. Simulators are useful for
in-app approval UI, but they do not prove production notification delivery.

Run the server and pair a mobile device, then verify:

1. Each approval kind renders in-app: `credential`, `capability`,
   `client-config`, `credential-input`, and `userland`.
2. Standard approvals resolve with `once`, `session`, `version`, `repo`, and
   `deny`.
3. `credential-input`, `client-config`, and `userland` notifications open the
   app instead of resolving inline.
4. Background action presses queue locally, update the notification to syncing,
   and drain after reconnect or foreground.
5. Resolving from Electron cancels the mobile notification.
6. Removing the server service-account JSON keeps in-app approvals working and
   logs push delivery as log-only.
7. Android builds both with and without `google-services.json`.
8. iOS builds after `pod install` with a real `GoogleService-Info.plist`; local
   simulator builds may omit Firebase config when testing non-push UI.
