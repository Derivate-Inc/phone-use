#!/bin/bash
# Prove an Android host end to end without the control plane: boot one
# read-only instance through the SDK engine, drive it through the harness CLI
# (observe → home → open Settings → screenshot), then kill it.
#
#   ANDROID_HOME=/opt/android-sdk bash deploy/scaleway/smoke-android-host.sh [avd]
set -euo pipefail
cd "$(dirname "$0")/../.."
AVD=${1:-${PHONE_USE_ANDROID_AVD:-phone-use-golden}}
export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
export PHONE_USE_ADB_BIN=${PHONE_USE_ADB_BIN:-$ANDROID_HOME/platform-tools/adb}
BUN=${BUN:-$HOME/.bun/bin/bun}

echo "== kvm";       test -w /dev/kvm && echo "   ok"
echo "== adb";       "$PHONE_USE_ADB_BIN" version | head -1
echo "== emulator";  "$ANDROID_HOME/emulator/emulator" -version | head -1

echo "== boot + drive via the SDK (android.launch → observe → screenshot)"
"$BUN" packages/phone-use/scripts/smoke-android.ts "$AVD"
echo "== SMOKE PASSED"
