#!/bin/bash
# Bootstrap a Scaleway Apple-silicon host as a phone-use worker.
# Usage: bootstrap-host.sh <ip> [ssh-key-path]
# Idempotent: safe to re-run. Assumes the repo is the cwd (rsynced to the host).
set -euo pipefail
IP=${1:?usage: bootstrap-host.sh <ip> [ssh-key-path]}
KEY=${2:-$HOME/.ssh/id_ed25519}
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "m1@$IP")

echo "== waiting for SSH on $IP"
until "${SSH[@]}" true 2>/dev/null; do sleep 15; done

echo "== host facts"
"${SSH[@]}" "sw_vers -productVersion; xcodebuild -version | head -1 || true"

echo "== raising process/fd limits (full effect after next reboot)"
scp -q -i "$KEY" deploy/scaleway/launchd/com.phone-use.limits.plist "m1@$IP:/tmp/"
"${SSH[@]}" 'sudo -n cp /tmp/com.phone-use.limits.plist /Library/LaunchDaemons/ 2>/dev/null || echo "  (sudo needs a password — run the cp manually or via vm create which knows it)"'

echo "== bun + repo"
"${SSH[@]}" 'command -v ~/.bun/bin/bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
rsync -az -e "ssh -i $KEY" --exclude node_modules --exclude .git --exclude .env ./ "m1@$IP:~/phone-use/"
"${SSH[@]}" 'cd ~/phone-use && ~/.bun/bin/bun install && sh apps/api/native/build.sh'

echo "== iOS simulator runtime (skipped if present; ~8.5GB download otherwise)"
"${SSH[@]}" 'xcrun simctl list runtimes | grep -q iOS || xcodebuild -downloadPlatform iOS'
"${SSH[@]}" 'xcrun simctl list runtimes | grep iOS || true'

echo "== BOOTSTRAP DONE — $IP is ready; start the worker with deploy/scaleway env files"
