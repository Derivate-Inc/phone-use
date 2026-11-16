#!/bin/bash
# Bootstrap a Linux/KVM host as a phone-use Android worker: adb + the Android
# SDK emulator + one golden AVD, a `phoneuse` service account, and the systemd
# unit. Runs ON the host (Ubuntu 22.04/24.04, x86_64) as a sudoer.
#
#   sudo bash deploy/scaleway/bootstrap-android-host.sh [api-level] [avd-name]
#
# Idempotent: safe to re-run. The emulator needs /dev/kvm — a bare-metal box
# (Scaleway Elastic Metal, Hetzner AX) or a VM with nested virtualization.
set -euo pipefail

API=${1:-34}
AVD=${2:-phone-use-golden}
SDK=/opt/android-sdk
IMAGE="system-images;android-${API};google_apis;x86_64"
REPO=/opt/phone-use
CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip

echo "== host facts"
uname -m | grep -q x86_64 || { echo "x86_64 host required (the emulator images are x86_64)"; exit 1; }
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  echo "/dev/kvm is missing or not writable — the emulator cannot run at usable speed."
  echo "Use bare metal or a VM with nested virtualization enabled, then re-run."
  exit 1
fi
nproc; free -g | head -2

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq adb unzip curl git openjdk-17-jre-headless libpulse0 libgl1 libnss3 libxcb-cursor0 >/dev/null

echo "== service account"
id phoneuse >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups kvm phoneuse
usermod -aG kvm phoneuse
mkdir -p "$SDK" /etc/phone-use /var/lib/phone-use/worker
chown -R phoneuse:phoneuse "$SDK" /var/lib/phone-use

echo "== android sdk command-line tools → $SDK"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  # root's mktemp -d is mode 700, which phoneuse cannot read — unzip as root
  # and chown the result instead of running the extraction as phoneuse.
  tmp=$(mktemp -d)
  curl -fsSL "$CMDLINE_TOOLS_URL" -o "$tmp/tools.zip"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  mkdir -p "$SDK/cmdline-tools"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  chown -R phoneuse:phoneuse "$SDK/cmdline-tools"
  rm -rf "$tmp"
fi
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
sudo -u phoneuse bash -c "yes | $SDKMANAGER --licenses >/dev/null"
sudo -u phoneuse "$SDKMANAGER" --install "platform-tools" "emulator" "$IMAGE" >/dev/null

echo "== golden AVD: $AVD ($IMAGE)"
if ! sudo -u phoneuse "$SDK/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx "$AVD"; then
  echo no | sudo -u phoneuse "$SDK/cmdline-tools/latest/bin/avdmanager" create avd \
    -n "$AVD" -k "$IMAGE" -d pixel_6 >/dev/null
  # Provider instances run -read-only; that requires the AVD to have booted
  # once normally so its quick-boot snapshot and userdata exist.
  echo "   first boot to seed the snapshot (~1-3 min)…"
  # cd to a phoneuse-traversable directory first: QEMU probes a RELATIVE
  # sysconf path (unused/…/etc/qemu/qemu.conf) from its cwd, and from root's
  # cwd (/root) that probe returns EACCES instead of ENOENT — which QEMU
  # treats as fatal and exits 1 with no error message.
  sudo -u phoneuse bash -c "cd ~ && ANDROID_HOME='$SDK' '$SDK/emulator/emulator' -avd '$AVD' -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect" >/tmp/avd-first-boot.log 2>&1 &
  EMU=$!
  sudo -u phoneuse "$SDK/platform-tools/adb" -s emulator-5554 wait-for-device
  until [ "$(sudo -u phoneuse "$SDK/platform-tools/adb" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
  sudo -u phoneuse "$SDK/platform-tools/adb" -s emulator-5554 emu kill
  wait "$EMU" || true
fi

echo "== bun + repo → $REPO"
if [ ! -d "$REPO/.git" ]; then
  echo "   clone the repository to $REPO first (sudo -u phoneuse git clone <url> $REPO), then re-run"
else
  sudo -u phoneuse bash -lc 'command -v ~/.bun/bin/bun >/dev/null || curl -fsSL https://bun.sh/install | bash'
  sudo -u phoneuse bash -lc "cd $REPO && ~/.bun/bin/bun install --frozen-lockfile"
fi

echo "== service"
[ -f /etc/phone-use/worker.env ] || {
  cp "$REPO/deploy/scaleway/worker-android.env.example" /etc/phone-use/worker.env 2>/dev/null || true
  chmod 600 /etc/phone-use/worker.env
  echo "   edit /etc/phone-use/worker.env (control URL, worker token, public URL) before starting"
}
cp "$REPO/deploy/scaleway/systemd/phone-use-worker.service" /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload

echo "== BOOTSTRAP DONE"
echo "   smoke:  sudo -u phoneuse ANDROID_HOME=$SDK bash $REPO/deploy/scaleway/smoke-android-host.sh"
echo "   start:  systemctl enable --now phone-use-worker"
