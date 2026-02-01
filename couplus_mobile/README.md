# couplus_mobile

Flutter mobile app groundwork for Couplus.

## Server base URL

Currently hardcoded to:

- `http://macmini.tail4fbf54.ts.net:3000`

(see `lib/api/api_client.dart`)

## Generate platform folders (first time)

This repo environment may not have Flutter installed, so this project is committed as a minimal Flutter app skeleton (no `android/` / `ios/` yet).

On a machine with Flutter installed:

```bash
cd couplus_mobile
flutter --version
flutter create . --platforms=android,ios
flutter pub get
```

If `flutter create` overwrote `lib/main.dart`, re-apply the committed file (git checkout).

## Run

```bash
cd couplus_mobile
flutter pub get
flutter run
```

## What it shows

- Bottom tabs: Home / Work / More
- Home: calls `/api/dashboard` and shows session + counts
- Work: shows preview history from `/api/dashboard`
- More: settings screen (server address read-only)
