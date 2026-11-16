#!/bin/sh
# Build phone-use-helper.jar (a dex jar run with app_process on the device).
# Needs a JDK and the Android SDK's platforms;android-35 and build-tools;35.0.0.
# The built jar is committed, so installs never need these tools.
set -eu
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
ANDROID_JAR="$SDK/platforms/android-35/android.jar"
D8="$SDK/build-tools/35.0.0/d8"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
javac --release 11 -cp "$ANDROID_JAR" -d "$OUT/classes" src/dev/phoneuse/android/Helper.java
(cd "$OUT/classes" && jar cf "$OUT/classes.jar" .)
"$D8" --release --min-api 24 --lib "$ANDROID_JAR" --output "$OUT" "$OUT/classes.jar"
(cd "$OUT" && jar cf phone-use-helper.jar classes.dex)
cp "$OUT/phone-use-helper.jar" phone-use-helper.jar
shasum -a 256 phone-use-helper.jar
