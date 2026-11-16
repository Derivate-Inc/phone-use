#!/bin/sh
set -eu
cd "$(dirname "$0")"
xcrun swiftc -O phone-video.swift -o phone-video
xcrun clang -O2 -fobjc-arc -fblocks -framework AppKit -framework CoreVideo -framework IOSurface \
  phone-input.m simdeck/DFPrivateSimulatorDisplayBridge.m -o phone-input
