# NatStack Mobile

The mobile app is a React Native shell for pairing with a NatStack server,
rendering panels, and handling approval prompts in-app or through FCM/APNs push
notifications.

## Push Approvals

Provision Firebase before testing notification actions:

- Android: copy `android/app/google-services.template.json` to
  `android/app/google-services.json` and replace it with the real Firebase
  config.
- iOS: copy `ios/NatStack/GoogleService-Info.template.plist` to
  `ios/NatStack/GoogleService-Info.plist` and replace it with the real Firebase
  config.
- Server: set `NATSTACK_FIREBASE_SERVICE_ACCOUNT_PATH` or
  `NATSTACK_FIREBASE_SERVICE_ACCOUNT_JSON`.

Full architecture, security notes, decision semantics, and native test steps
are in [docs/approvals.md](../../docs/approvals.md).

## Panel Automation

Mobile panels use the WebView bridge for non-CDP runtime introspection.
Workspace panel handles can call `snapshot()`, `tree()`, `state()`,
`routes()`, and `setMode()`; the mobile host loads the target WebView when
needed and dispatches to the panel's registered `_agent.*` handlers.

CDP automation always runs through the server broker and requires a
CDP-capable Electron host. The mobile app does not expose an Android WebView
CDP proxy or a direct WebView drive path. Panels held by the mobile host are
not CDP targets; `handle.cdp.page()` and drive verbs reject while a target is
leased to mobile rather than taking it over silently. iOS `WKWebView` does not
provide CDP, so brokered CDP automation remains unavailable for mobile-held
panels there as well.

## Local Checks

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile type-check
pnpm -C apps/mobile lint
```

For Android WebRTC pairing and local relay testing, see
[docs/webrtc-local-e2e.md](../../docs/webrtc-local-e2e.md) and
[docs/webrtc-deployment.md](../../docs/webrtc-deployment.md).
