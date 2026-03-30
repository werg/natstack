# NatStack iOS Native Project

The Xcode project file (`NatStack.xcodeproj/project.pbxproj`) is too complex
to generate manually. Use React Native CLI to generate it:

```bash
# From the repository root:
npx react-native init NatStack --directory temp-ios --version 0.79.2

# Copy the generated iOS project files:
cp -r temp-ios/ios/NatStack.xcodeproj mobile/ios/
cp -r temp-ios/ios/NatStack mobile/ios/  # (merge with existing Info.plist)
cp temp-ios/ios/NatStack/LaunchScreen.storyboard mobile/ios/NatStack/

# Clean up:
rm -rf temp-ios
```

After generating, update the Xcode project:
1. Set the bundle identifier to `com.natstack.mobile`
2. Set the deployment target to iOS 15.0
3. Add the `natstack` URL scheme in Info.plist for OAuth deep links
4. Run `cd mobile/ios && pod install` to install CocoaPods dependencies

The `Info.plist` and `Podfile` are already configured for NatStack.
