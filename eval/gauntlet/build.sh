#!/bin/bash
# Build Gauntlet.app (the eval's oracle app) for the iOS simulator with plain swiftc, no Xcode
# project, and optionally install it. Usage: ./build.sh [udid ...]
set -euo pipefail
cd "$(dirname "$0")"

APP=build/Gauntlet.app
rm -rf "$APP"
mkdir -p "$APP"

xcrun -sdk iphonesimulator swiftc \
  -parse-as-library \
  -module-name Gauntlet \
  -target arm64-apple-ios17.0-simulator \
  -O \
  Gauntlet.swift \
  -o "$APP/Gauntlet"

cat > "$APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.phoneuse.gauntlet</string>
  <key>CFBundleName</key><string>Gauntlet</string>
  <key>CFBundleDisplayName</key><string>Gauntlet</string>
  <key>CFBundleExecutable</key><string>Gauntlet</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UIApplicationSceneManifest</key>
  <dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationLandscapeLeft</string>
    <string>UIInterfaceOrientationLandscapeRight</string>
  </array>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>com.phoneuse.gauntlet</string>
    <key>CFBundleURLSchemes</key><array><string>gauntlet</string></array>
  </dict></array>
  <key>NSLocationWhenInUseUsageDescription</key>
  <string>Gauntlet asks for your location to test permission prompts. Token GAUNTLET-LOC-7731.</string>
  <key>NSUserTrackingUsageDescription</key>
  <string>Gauntlet asks to track you to test the tracking prompt. Token GAUNTLET-ATT-4402.</string>
</dict>
</plist>
PLIST

# Simulator apps still need an ad-hoc signature for some entitlements checks.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

for udid in "$@"; do
  xcrun simctl install "$udid" "$APP"
  echo "installed com.phoneuse.gauntlet on $udid"
done
echo "built $(pwd)/$APP"
