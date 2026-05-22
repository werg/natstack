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

Mobile panels use the WebView bridge for supported automation. Workspace panel
handles can call `snapshot()`, `tree()`, `state()`, `routes()`, and `setMode()`;
the mobile host loads the target WebView when needed and dispatches to the
panel's registered `_agent.*` handlers. Browser panel handles support direct
host navigation methods such as `navigate()`, `goBack()`, `goForward()`,
`reload()`, and `stop()`.

Android WebView debugging is enabled by default when the WebView implementation
supports it, so attached development tools can inspect WebView targets through
the platform's Android-only debugging backend. NatStack also ships an
Android-only in-app CDP proxy: `handle.browser.page()` starts a loopback
TCP proxy to `webview_devtools_remote_<pid>`, discovers the matching `/json`
target, and connects Playwright to the returned WebSocket URL. iOS `WKWebView`
does not provide CDP, so browser-page automation remains unavailable there.

## Local Checks

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile type-check
pnpm -C apps/mobile lint
```

For Android device pairing over VPN or LAN, see
[docs/mobile-vpn.md](../../docs/mobile-vpn.md).
