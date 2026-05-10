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

## Local Checks

```bash
pnpm -C apps/mobile test
pnpm -C apps/mobile type-check
pnpm -C apps/mobile lint
```

For Android device pairing over VPN or LAN, see
[docs/mobile-vpn.md](../../docs/mobile-vpn.md).
