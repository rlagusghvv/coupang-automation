# CoupElephant iOS Archive / Upload Notes (v0.1.0+3)

## 1) Confirm version/build
- `pubspec.yaml` → `version: 0.1.0+3`
- Flutter will map:
  - CFBundleShortVersionString = `0.1.0`
  - CFBundleVersion = `3`

## 2) Build IPA (recommended)
From `couplus_mobile/`:

```bash
flutter clean
flutter pub get
flutter build ipa --release
```

Output is typically under:
- `build/ios/ipa/*.ipa`

## 3) Xcode Archive (alternative)
1. `open ios/Runner.xcworkspace`
2. Select scheme `Runner` and `Any iOS Device (arm64)`
3. `Product → Archive`
4. In Organizer → Distribute App → App Store Connect → Upload

## Notes
- If App Store Connect upload fails due to signing/profiles, check:
  - Xcode → Signing & Capabilities
  - Apple ID login in Xcode settings
  - Bundle ID matches App Store record
