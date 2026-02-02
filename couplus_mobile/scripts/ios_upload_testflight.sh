#!/usr/bin/env bash
set -euo pipefail

# CoupElephant iOS: build + upload to TestFlight automatically.
# Requires:
# - Apple Distribution cert installed in Keychain
# - App Store Connect API key json at ~/.openclaw/secrets/appstoreconnect/api_key.json
#   { key_id, issuer_id, key: /path/to/AuthKey_*.p8 }

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

APP_ID="com.hyunho.coupelephant.app"
TEAM_ID="FCHA9MNH8C"
API_KEY_JSON="${OPENCLAW_ASC_API_KEY_JSON:-$HOME/.openclaw/secrets/appstoreconnect/api_key.json}"

if [[ ! -f "$API_KEY_JSON" ]]; then
  echo "Missing API key json: $API_KEY_JSON" >&2
  exit 1
fi

command -v fastlane >/dev/null || {
  echo "fastlane not found. Install: brew install fastlane" >&2
  exit 1
}

# 1) Fetch App Store provisioning profile via API key
TMP_DIR="$(mktemp -d)"
PROFILE_PATH="$TMP_DIR/appstore.mobileprovision"

fastlane sigh \
  --platform ios \
  --app_identifier "$APP_ID" \
  --api_key_path "$API_KEY_JSON" \
  --output_path "$TMP_DIR" \
  --filename "appstore.mobileprovision" \
  --skip_install true \
  --quiet

if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "Failed to download provisioning profile" >&2
  exit 1
fi

PROFILE_NAME="$(security cms -D -i "$PROFILE_PATH" | plutil -extract Name raw -o - -)"
PROFILE_UUID="$(security cms -D -i "$PROFILE_PATH" | plutil -extract UUID raw -o - -)"

# Install profile locally so xcodebuild can find it
PROFILE_INSTALL_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILE_INSTALL_DIR"
cp -f "$PROFILE_PATH" "$PROFILE_INSTALL_DIR/$PROFILE_UUID.mobileprovision"

echo "Using provisioning profile: $PROFILE_NAME ($PROFILE_UUID)"

# 2) Write exportOptions.plist for App Store export (manual signing)
EXPORT_PLIST="$TMP_DIR/ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$APP_ID</key>
    <string>$PROFILE_NAME</string>
  </dict>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>compileBitcode</key>
  <false/>
</dict>
</plist>
EOF

# 3) Build IPA
flutter clean >/dev/null
flutter pub get >/dev/null

flutter build ipa --release --export-options-plist "$EXPORT_PLIST"

IPA_PATH="$(ls -1 "$ROOT_DIR/build/ios/ipa"/*.ipa | head -n 1)"
if [[ ! -f "$IPA_PATH" ]]; then
  echo "IPA not found under build/ios/ipa" >&2
  exit 1
fi

echo "Built IPA: $IPA_PATH"

# 4) Upload to TestFlight
fastlane pilot upload \
  --api_key_path "$API_KEY_JSON" \
  --ipa "$IPA_PATH" \
  --skip_waiting_for_build_processing true

echo "Upload submitted. Processing may take a while in TestFlight."
