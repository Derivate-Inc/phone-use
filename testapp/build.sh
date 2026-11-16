#!/bin/bash
# Build Labyrinth.app for the iOS simulator with plain swiftc (no Xcode project)
# and install it on the booted device. Usage: ./build.sh [udid]
set -euo pipefail
cd "$(dirname "$0")"

UDID="${1:-booted}"
APP=Labyrinth.app
rm -rf "$APP"
mkdir -p "$APP"

xcrun -sdk iphonesimulator swiftc \
  -parse-as-library \
  -target arm64-apple-ios17.0-simulator \
  -O \
  Labyrinth.swift \
  -o "$APP/Labyrinth"

cat > "$APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.phoneuse.labyrinth</string>
  <key>CFBundleName</key><string>Labyrinth</string>
  <key>CFBundleDisplayName</key><string>Labyrinth</string>
  <key>CFBundleExecutable</key><string>Labyrinth</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  <key>MinimumOSVersion</key><string>17.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST

xcrun simctl install "$UDID" "$APP"
echo "installed com.phoneuse.labyrinth on $UDID"
