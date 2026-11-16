---
name: phone-use
description: Drive a phone from the phone-use CLI — the iOS Simulator or an Android device on this machine (free, no account), or a cloud phone (waitlist). Control real apps, run several phones in parallel, and verify results honestly.
---

# phone-use — give your agent a phone

A CLI an agent drives a phone with. On this machine it is free and needs no
account: it drives the iOS Simulator on a Mac, or an Android device or emulator
over adb. Cloud phones are on a waitlist.

## Setup

```bash
npm i -g phone-use    # or: bun add -g phone-use
phone-use doctor      # checks Bun, Xcode and simulators
```

## Start on this machine

```bash
open -a Simulator      # macOS + Xcode. For Android: phone-use connect android
phone-use observe      # "no iOS simulator is booted"? It is still starting: wait a few seconds, run again
phone-use tap "Settings"
```

With no other device chosen, every verb drives the one booted simulator. No
login, no key, nothing sent to phone-use's servers.

## Cloud phones are on a waitlist

`phone-use create ios` gives a cloud phone only to an approved account. For
everyone else it creates nothing, prints a message, and exits `1`. When you see
`Cloud phones are on a waitlist`:

1. Do not retry `create`, and do not ask the user to log in again.
2. Continue on this machine with the command the message gives.
3. Tell the user they can join the waitlist at https://phoneuse.dev/waitlist.

The rest of this section applies only when the user's account is approved.

### The attach pattern (the #1 thing to get right with cloud phones)

Every shell command runs in a fresh shell, so a cloud phone's connection env
must be sourced into EACH command:

```bash
phone-use login       # browser sign-in, saves the API key
id=$(phone-use create ios --ttl 15m | head -1 | awk '{print $1}')
[ -n "$id" ] || exit 1   # empty id: create was refused (waitlist) or failed; read its message
phone-use env "$id" > /tmp/phone.env
source /tmp/phone.env && phone-use observe
source /tmp/phone.env && phone-use tap "Settings"
```

## Core verbs

- `observe` — frontmost app + visible elements. Pipe through `head`, not `tail`:
  the screen's identity is the `NavigationBar` line at the TOP.
- `screenshot` — the rich channel; use when observe's tree isn't enough.
- `tap "<label>"` — target elements by LABEL text (partial match works). NEVER
  reuse `@e` refs across commands; refs expire every invocation.
- `type`, `scroll`, `drag`, `nav back|home`, `open <app>`, `wait_for "<text>"`
- `search <app> <query>` — in-app search. The FIRST arg is the app:
  `phone-use search Wikipedia "Kyoto"`, never `phone-use search "Kyoto"`.
- `batch` — several verbs in one invocation; prefer it for known sequences, it
  is much faster than one CLI call per step.
- `task "<goal>"` — built-in agent runs a whole goal end to end.

## Flag gotchas

Boolean flags are BARE, even where help text shows `<boolean>`:
`--open true` errors — write `--open`. Same for `--submit`. Destructive verbs
like `type` may ask for confirmation; re-run with `--yes`.

## Parallel fleets (cloud phones, approved accounts)

Drive N phones from ONE bash call with background subshells — never one at a time:

```bash
for spec in "1:Kyoto" "2:Jupiter" "3:San Francisco"; do
( n="${spec%%:*}"; t="${spec#*:}"
  id=$(phone-use create ios --ttl 15m | head -1 | awk '{print $1}')
  echo "$id" >> /tmp/fleet-ids
  phone-use env "$id" > /tmp/p$n.env
  source /tmp/p$n.env && phone-use search Wikipedia "$t" --open --match "$t"
) &
done
wait
# always clean up:
for id in $(cat /tmp/fleet-ids); do phone-use close "$id" & done; wait
```

## Verify honestly

- A success message is not evidence. Confirm state by reading it back where it
  lives — an element of the thing itself, not a banner saying it worked.
- Webview content (articles, browsers) fills the element tree a beat AFTER the
  action returns. Poll `observe` for a few seconds for an element named for your
  target before declaring success — the first matching substring may be a nav
  icon, not the content.
- A freshly created cloud phone can report running ~30s before it is fully driveable.
  If `observe` says `App: unknown`, wait and retry rather than failing.

## Etiquette

- `close` every cloud phone you create; `--ttl` is the backstop, not the cleanup.
- Don't re-observe after every action — act, then verify once at the end.
- `list` shows the cloud phones you have running if you lose track.
