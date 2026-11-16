'use client'

import type { ReactNode } from 'react'
import {
  ArrowLeft,
  BatteryFull,
  Bell,
  Bluetooth,
  Camera,
  ChevronLeft,
  ChevronRight,
  Hourglass,
  LayoutGrid,
  Moon,
  PersonStanding,
  Plane,
  Search,
  Settings,
  Sun,
  Volume2,
  Wifi,
} from 'lucide-react'
import type { Act } from './kit/act'
import { Phone } from './kit/phone'
import { Stage } from './kit/stage'
import { Caret, Prompt, Window } from './kit/window'
import './phone-use-hero.css'

// Phone Use's homepage hero: one CLI, a phone on each platform, both on the
// user's own machine.
//
// A device pair at the page's content width, cut by the section rule below
// it. The terminal is where the agent works; the phone straddling its right
// edge is the device the CLI is driving. Beats:
//   1. On the iPhone: `ask "iOS Version"`. The phone walks Settings, General,
//      About on its own (two touches), the row it read is marked, and the
//      value prints. Payoff, held.
//   2. `connect android`: the iPhone leaves by the bottom, a Pixel rises in.
//      The agent taps "Network & internet"; the screen pushes and the
//      terminal confirms the tap.
//   3. `disconnect`: the Pixel leaves and the iPhone simulator rises back in
//      on Settings. That is the opening frame.
//
// The terminal is a full scrollback anchored at the crop: new lines push old
// ones up under a soft top edge. Its history is one whole previous loop, so
// the opening frame is complete, the seam is invisible, and nothing rewinds.
//
// Real strings: the commands and their output are the CLI's own (see
// packages/phone-use).

type Part = [string, string?]
type Line = ({ kind: 'cmd'; text: string } | { kind: 'out'; parts: Part[] }) & { fresh?: boolean }

type S = {
  lines: Line[]
  typed: string
  device: 'ios' | 'android'
  ios: 0 | 1 | 2
  droid: 0 | 1
  read: boolean
}

const cmd = (text: string): Line => ({ kind: 'cmd', text })
const out = (...parts: Part[]): Line => ({ kind: 'out', parts })

const ASK = [cmd('phone-use ask "iOS Version"'), out(['→ Settings › General › About', 'dim']), out(['iOS Version = '], ['26.1', 'val'])]
const TO_DROID = [cmd('phone-use connect android'), out(['✓ ', 'ok'], ['Connected to your Android device.'])]
const TAP = [cmd('phone-use tap "Network & internet"'), out(['✓ ', 'ok'], ['Tapped "Network & internet"'])]
const TO_IOS = [cmd('phone-use disconnect'), out(['Disconnected. Verbs target simulators and cloud phones again.', 'dim'])]

// One whole loop
const CYCLE: Line[] = [...ASK, ...TO_DROID, ...TAP, ...TO_IOS]
// The scrollback the opening frame inherits: two loops, because one is
// shorter than the terminal is tall and would leave its top empty
const HISTORY: Line[] = [...CYCLE, ...CYCLE]

const initial: S = { lines: HISTORY, typed: '', device: 'ios', ios: 0, droid: 0, read: false }
const POSTER: S = { ...initial, lines: [...HISTORY, ...ASK], ios: 2, read: true }

const REST = { wide: { x: 940, y: 420 }, compact: { x: 180, y: 520 } }

// Lines the script adds fade in; the inherited scrollback never does, so the
// loop's reset (which re-renders it) is invisible
const push = (...lines: Line[]) => (s: S) => ({ lines: [...s.lines, ...lines.map((l) => ({ ...l, fresh: true }))] })

async function run(a: Act<S>, text: string) {
  await a.type('typed', text, { interval: 22 })
  await a.wait(200)
  await a.set((s) => ({ ...push(cmd(text))(s), typed: '' }))
}

async function script(a: Act<S>) {
  await a.wait(800)

  // 1. Read a value on the iPhone: the phone finds the screen itself
  a.mark('ask')
  await run(a, 'phone-use ask "iOS Version"')
  await a.wait(220)
  await a.set(push(ASK[1]))
  await a.wait(240)
  await a.click({ at: 'ios-general', x: 0.72, y: 0.5 })
  await a.set({ ios: 1 })
  await a.wait(680)
  await a.click({ at: 'ios-about', x: 0.72, y: 0.5 })
  await a.set({ ios: 2 })
  await a.wait(560)
  a.mark('read')
  await a.set({ read: true })
  await a.wait(160)
  await a.set(push(ASK[2]))
  await a.wait(2100)

  // 2. The same CLI on Android
  a.mark('android')
  await run(a, 'phone-use connect android')
  await a.wait(520)
  await a.set((s) => ({ ...push(TO_DROID[1])(s), device: 'android' }))
  await a.wait(1000)
  // The iPhone is off stage now: put it back on Settings unseen
  await a.snap({ ios: 0, read: false })
  await a.wait(320)
  await run(a, 'phone-use tap "Network & internet"')
  await a.wait(240)
  await a.click({ at: 'droid-network', x: 0.7, y: 0.5 })
  await a.set({ droid: 1 })
  await a.wait(400)
  await a.set(push(TAP[1]))
  await a.wait(1900)

  // 3. Back to the iPhone simulator: the opening frame
  a.mark('ios')
  await run(a, 'phone-use disconnect')
  await a.wait(500)
  await a.set((s) => ({ ...push(TO_IOS[1])(s), device: 'ios' }))
  await a.wait(1000)
  await a.snap({ droid: 0 })
  // The scrollback's visible tail is now the inherited history line for line;
  // trim it to exactly that, unseen, so the next loop starts from initial
  await a.snap({ lines: HISTORY })
  // A touch shows only where it lands, so the return to rest is unseen
  await a.move(REST[a.layout])
  await a.wait(600)
}

// ── Terminal ─────────────────────────────────────────────────────────────

function Terminal({ s }: { s: S }) {
  return (
    <Window chrome="terminal" title="agent — zsh" lights="grey" className="pu-term">
      <div className="ss-term pu-scroll">
        {s.lines.map((line, i) =>
          line.kind === 'cmd' ? (
            <Prompt key={i} data-fresh={line.fresh || undefined}>
              {line.text}
            </Prompt>
          ) : (
            <div key={i} className="pu-out" data-fresh={line.fresh || undefined}>
              {line.parts.map(([text, cls], j) => (
                <span key={j} className={cls}>
                  {text}
                </span>
              ))}
            </div>
          ),
        )}
        <Prompt>
          {s.typed}
          <Caret still={s.typed.length > 0} />
        </Prompt>
      </div>
    </Window>
  )
}

// ── iOS Settings ─────────────────────────────────────────────────────────

const GLYPH = { size: 18, strokeWidth: 2.3, color: '#fff' }

function IosRow({ icon, tint, title, value, target, chevron = true }: { icon?: ReactNode; tint?: string; title: ReactNode; value?: ReactNode; target?: string; chevron?: boolean }) {
  return (
    <div className="pu-ios-row" data-target={target} data-icon={icon ? '' : undefined}>
      {icon && (
        <span className="pu-ios-tile" style={{ background: tint }}>
          {icon}
        </span>
      )}
      <span className="pu-ios-title">{title}</span>
      {value != null && <span className="pu-ios-value">{value}</span>}
      {chevron && <ChevronRight className="pu-ios-chev" size={16} strokeWidth={2.6} aria-hidden />}
    </div>
  )
}

function IosNav({ title }: { title: string }) {
  return (
    <div className="pu-ios-nav">
      <span className="pu-ios-back">
        <ChevronLeft size={24} strokeWidth={2.4} aria-hidden />
      </span>
      <span className="pu-ios-navtitle">{title}</span>
    </div>
  )
}

function IosSettings() {
  return (
    <>
      <div className="pu-ios-large">Settings</div>
      <div className="pu-ios-search">
        <Search size={18} strokeWidth={2.4} aria-hidden />
        Search
      </div>
      <div className="pu-ios-group">
        <IosRow icon={<Plane {...GLYPH} />} tint="#ff9500" title="Airplane Mode" />
        <IosRow icon={<Wifi {...GLYPH} />} tint="#0a84ff" title="Wi-Fi" value="Off" />
        <IosRow icon={<Bluetooth {...GLYPH} />} tint="#0a84ff" title="Bluetooth" value="On" />
      </div>
      <div className="pu-ios-group">
        <IosRow icon={<Settings {...GLYPH} />} tint="#8e8e93" title="General" target="ios-general" />
        <IosRow icon={<PersonStanding {...GLYPH} />} tint="#0a84ff" title="Accessibility" />
        <IosRow icon={<Camera {...GLYPH} />} tint="#8e8e93" title="Camera" />
        <IosRow icon={<Sun {...GLYPH} />} tint="#0a84ff" title="Display & Brightness" />
      </div>
      <div className="pu-ios-group">
        <IosRow icon={<Bell {...GLYPH} />} tint="#ff3b30" title="Notifications" />
        <IosRow icon={<Volume2 {...GLYPH} />} tint="#ff2d55" title="Sounds & Haptics" />
        <IosRow icon={<Moon {...GLYPH} />} tint="#5e5ce6" title="Focus" />
        <IosRow icon={<Hourglass {...GLYPH} />} tint="#5e5ce6" title="Screen Time" />
      </div>
    </>
  )
}

function IosGeneral() {
  return (
    <>
      <IosNav title="General" />
      <div className="pu-ios-group">
        <IosRow title="About" target="ios-about" />
        <IosRow title="Software Update" />
      </div>
      <div className="pu-ios-group">
        <IosRow title="AirDrop" />
        <IosRow title="AirPlay & Continuity" />
        <IosRow title="Picture in Picture" />
      </div>
      <div className="pu-ios-group">
        <IosRow title="AutoFill & Passwords" />
        <IosRow title="Background App Refresh" />
        <IosRow title="Date & Time" />
        <IosRow title="Dictionary" />
      </div>
    </>
  )
}

function IosAbout({ read }: { read: boolean }) {
  return (
    <>
      <IosNav title="About" />
      <div className="pu-ios-group">
        <IosRow title="Name" value="iPhone" />
        <div className="pu-ios-read" data-on={read || undefined}>
          <IosRow title="iOS Version" value="26.1" />
        </div>
        <IosRow title="Model Name" value="iPhone 17 Pro" chevron={false} />
      </div>
      <div className="pu-ios-group">
        <IosRow title="Songs" value="0" chevron={false} />
        <IosRow title="Videos" value="0" chevron={false} />
        <IosRow title="Photos" value="6" chevron={false} />
        <IosRow title="Applications" value="1" chevron={false} />
      </div>
    </>
  )
}

// ── Android Settings ─────────────────────────────────────────────────────

const MAT = { size: 22, strokeWidth: 2 }

function DroidRow({ icon, title, summary, target, tone = 'blue', trail }: { icon: ReactNode; title: string; summary?: string; target?: string; tone?: 'blue' | 'green' | 'teal' | 'amber' | 'rose' | 'violet'; trail?: ReactNode }) {
  return (
    <div className="pu-droid-row" data-target={target}>
      <span className="pu-droid-icon" data-tone={tone}>
        {icon}
      </span>
      <span className="pu-droid-text">
        <span className="pu-droid-title">{title}</span>
        {summary && <span className="pu-droid-summary">{summary}</span>}
      </span>
      {trail}
    </div>
  )
}

function DroidSettings() {
  return (
    <>
      <div className="pu-droid-large">Settings</div>
      <div className="pu-droid-search">
        <Search size={22} strokeWidth={2} aria-hidden />
        Search settings
      </div>
      <DroidRow icon={<Wifi {...MAT} />} title="Network & internet" summary="Mobile, Wi‑Fi, hotspot" target="droid-network" />
      <DroidRow icon={<Bluetooth {...MAT} />} title="Connected devices" summary="Bluetooth, pairing" tone="teal" />
      <DroidRow icon={<LayoutGrid {...MAT} />} title="Apps" summary="Recent apps, default apps" tone="green" />
      <DroidRow icon={<Bell {...MAT} />} title="Notifications" summary="Notification history, conversations" tone="amber" />
      <DroidRow icon={<BatteryFull {...MAT} />} title="Battery" summary="100%" tone="rose" />
      <DroidRow icon={<Sun {...MAT} />} title="Display" summary="Dark theme, font size, brightness" tone="violet" />
    </>
  )
}

function DroidNetwork() {
  return (
    <>
      <div className="pu-droid-bar">
        <span className="pu-droid-back">
          <ArrowLeft size={24} strokeWidth={2} aria-hidden />
        </span>
      </div>
      <div className="pu-droid-heading">Network &amp; internet</div>
      <DroidRow icon={<Wifi {...MAT} />} title="Internet" summary="AndroidWifi" />
      <DroidRow icon={<LayoutGrid {...MAT} />} title="Calls & SMS" tone="teal" />
      <DroidRow
        icon={<Plane {...MAT} />}
        title="Airplane mode"
        tone="amber"
        trail={
          <span className="pu-droid-switch" aria-hidden>
            <span />
          </span>
        }
      />
      <DroidRow icon={<Bluetooth {...MAT} />} title="Hotspot & tethering" summary="Off" tone="green" />
      <DroidRow icon={<Moon {...MAT} />} title="Data Saver" summary="Off" tone="violet" />
    </>
  )
}

// A navigation stack: the screen at `depth` is in place, deeper ones wait off
// the right edge, shallower ones sit pushed to the left under it.
function Stack({ depth, screens, platform }: { depth: number; screens: ReactNode[]; platform: 'ios' | 'android' }) {
  return (
    <div className="pu-stack" data-platform={platform}>
      {screens.map((screen, i) => (
        <div key={i} className="pu-screen" data-pos={i === depth ? 'in' : i < depth ? 'under' : 'next'}>
          {screen}
        </div>
      ))}
    </div>
  )
}

export default function PhoneUseHero() {
  return (
    <Stage
      width={1120}
      height={470}
      compact={{ below: 720, width: 342, height: 620 }}
      initial={initial}
      poster={POSTER}
      script={script}
      cursor={{ at: REST, style: 'touch' }}
      greys="cool"
      accent="#6c4cff"
      fill
      className="pu-hero"
    >
      {(s, _rect, layout) => (
        <>
          <Terminal s={s} />
          <Phone width={layout === 'compact' ? 290 : 360} frame="pro" time="9:41" wallpaper="#f2f2f7" className="pu-phone" data-away={s.device !== 'ios' || undefined}>
            <Stack platform="ios" depth={s.ios} screens={[<IosSettings key="s" />, <IosGeneral key="g" />, <IosAbout key="a" read={s.read} />]} />
          </Phone>
          <Phone width={layout === 'compact' ? 290 : 360} frame="android" time="10:24" wallpaper="#f8f9fc" className="pu-phone" data-away={s.device !== 'android' || undefined}>
            <Stack platform="android" depth={s.droid} screens={[<DroidSettings key="s" />, <DroidNetwork key="n" />]} />
          </Phone>
        </>
      )}
    </Stage>
  )
}
