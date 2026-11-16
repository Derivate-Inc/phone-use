#!/usr/bin/env bash
# Installs phone-use, the CLI that gives AI agents cloud iOS and Android phones.
#
#   curl -fsSL https://phoneuse.dev/install | bash
#
# phone-use runs on Bun. This script installs Bun (https://bun.sh) if it is
# missing, then installs the phone-use package from npm with `bun add -g`.
# Run it again to update.
# Source: https://github.com/Derivate-Inc/phone-use/blob/main/apps/landing/public/install.sh

# Piped to `sh`, this may run in a shell other than bash (dash on Debian and
# Ubuntu). This check is plain POSIX, so it runs there and stops early.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: run this script with bash: curl -fsSL https://phoneuse.dev/install | bash" >&2
  exit 1
fi

set -euo pipefail

MIN_BUN=1.3.0

if [[ -t 1 ]]; then
  bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' dim='' green='' red='' reset=''
fi

say() { printf '%s\n' "$*"; }
fail() {
  printf '%serror%s: %s\n' "$red" "$reset" "$*" >&2
  exit 1
}
tildify() {
  case $1 in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# version_at_least 1.4.4 1.3.0 → true. Pre-release suffixes are ignored.
version_at_least() {
  local IFS=. i h w have want
  read -r -a have <<<"$1"
  read -r -a want <<<"$2"
  for i in 0 1 2; do
    h=${have[i]:-0} w=${want[i]:-0}
    h=${h%%[!0-9]*} w=${w%%[!0-9]*}
    if ((${h:-0} > ${w:-0})); then return 0; fi
    if ((${h:-0} < ${w:-0})); then return 1; fi
  done
  return 0
}

# Does a shell profile already put this directory on PATH? Bun's installer
# writes `$BUN_INSTALL/bin` to the profile, but only when the profile exists.
in_profile() {
  local f
  for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.config/fish/config.fish"; do
    [[ -f $f ]] || continue
    if grep -qF -e "$1" -e "${1#"$HOME"/}" -e 'BUN_INSTALL/bin' "$f"; then return 0; fi
  done
  return 1
}

# The line that puts a directory on PATH for the user's shell, ready to paste.
# Written with $HOME rather than ~, which doesn't expand inside quotes.
path_hint() {
  local dir=$1 shown rc
  case $dir in
    "$HOME"/*) shown="\$HOME/${dir#"$HOME"/}" ;;
    *) shown=$dir ;;
  esac
  case ${SHELL:-} in
    */zsh) rc='~/.zshrc' ;;
    */bash) if [[ $(uname -s) == Darwin ]]; then rc='~/.bash_profile'; else rc='~/.bashrc'; fi ;;
    */fish)
      say "  fish_add_path $shown"
      return
      ;;
    *)
      say "  export PATH=\"$shown:\$PATH\"    ${dim}# in your shell profile${reset}"
      return
      ;;
  esac
  say "  echo 'export PATH=\"$shown:\$PATH\"' >> $rc"
}

# Everything runs from main, so a partial download executes nothing.
main() {
  case "$(uname -s)" in
    Darwin | Linux) ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "this script supports macOS and Linux. On Windows, install Node and Bun, then run: npm install -g phone-use"
      ;;
    *) fail "unsupported system: $(uname -s). phone-use installs on macOS and Linux." ;;
  esac

  local user_path=$PATH bun_home=${BUN_INSTALL:-$HOME/.bun} bun

  # 1. Bun
  bun=$(command -v bun || true)
  if [[ -z $bun && -x $bun_home/bin/bun ]]; then
    bun=$bun_home/bin/bun
  fi
  if [[ -z $bun ]]; then
    local tool
    for tool in curl unzip; do
      command -v "$tool" >/dev/null 2>&1 ||
        fail "installing Bun needs $tool. Install $tool with your package manager, then run this script again."
    done
    say "Installing Bun, which phone-use runs on…"
    curl -fsSL https://bun.sh/install | bash >/dev/null
    bun=$bun_home/bin/bun
    [[ -x $bun ]] || fail "Bun did not install. See https://bun.sh for help."
    "$bun" --version >/dev/null 2>&1 ||
      fail "Bun installed but doesn't run on this system. See https://bun.sh/docs/installation for its requirements."
  else
    local bun_version
    bun_version=$("$bun" --version)
    version_at_least "$bun_version" "$MIN_BUN" ||
      fail "phone-use needs Bun $MIN_BUN or newer, and $(tildify "$bun") is $bun_version. Run 'bun upgrade', then run this script again."
  fi

  # 2. phone-use
  say "Installing phone-use…"
  local bin_dir link log
  bin_dir=$("$bun" pm bin -g)
  link=$bin_dir/phone-use
  # An earlier run without Node left its own script here (below). Bun only
  # replaces its own links, so clear it first or the update fails.
  if [[ -f $link && ! -L $link ]] && grep -qF 'phoneuse.dev/install' "$link"; then
    rm -f "$link"
  fi
  if ! log=$("$bun" add -g phone-use </dev/null 2>&1); then
    printf '%s\n' "$log" >&2
    fail "bun add -g phone-use failed."
  fi
  [[ -e $link ]] || fail "Bun finished, but $(tildify "$link") is missing."

  # The package's launcher starts with `#!/usr/bin/env node`. Without Node,
  # swap Bun's link for a short script that runs the launcher with Bun.
  if ! command -v node >/dev/null 2>&1; then
    local target pkg
    target=$(readlink "$link") || fail "expected $(tildify "$link") to be a link Bun created."
    [[ $target == /* ]] || target=$bin_dir/$target
    pkg=$(cd "$(dirname "$target")/.." && pwd)
    rm -f "$link"
    cat >"$link" <<EOF
#!/bin/sh
# Written by https://phoneuse.dev/install: Node isn't installed, so run phone-use with Bun.
export PATH="$(dirname "$bun"):\$PATH"
exec "$bun" "$pkg/bin/phone-use.cjs" "\$@"
EOF
    chmod +x "$link"
  fi

  # 3. Check it starts. The launcher finds Bun on PATH.
  local version
  version=$(PATH="$bin_dir:$(dirname "$bun"):$PATH" "$link" --version 2>&1) ||
    fail "phone-use installed but did not start: $version"

  say ""
  say "${green}✓${reset} ${bold}${version}${reset} installed ${dim}($(tildify "$link"))${reset}"

  case ":$user_path:" in
    *":$bin_dir:"*)
      # Another copy earlier on PATH (an older npm install, say) would run instead.
      local first
      first=$(command -v phone-use || true)
      if [[ -n $first && $first != "$link" ]]; then
        say ""
        say "$(tildify "$first") comes first on your PATH, so \`phone-use\` runs that copy."
        say "Remove it (for an npm install: npm uninstall -g phone-use), or move $(tildify "$bin_dir") ahead of it."
      fi
      ;;
    *)
      say ""
      if in_profile "$bin_dir"; then
        say "Open a new terminal to use phone-use."
      else
        say "$(tildify "$bin_dir") isn't on your PATH yet. Add it, then open a new terminal:"
        path_hint "$bin_dir"
      fi
      ;;
  esac

  say ""
  say "Next:"
  say "  phone-use login"
  say "  phone-use create ios      ${dim}# or: phone-use create android${reset}"
}

main "$@"
