'use client'

// The capability cells under the hero: one Stage per cell, each telling one
// thing once (references/bento.md). Copy lives in the page, outside the stage.
//
// The grid is ruled: one white container, hairlines between cells. Pictures
// sit straight on the cell, no card inside a card, and fade out at its foot.
// The command that produced a picture heads it, in one small mono chip. The
// accent has one job on the page: what the agent read.
//
//   ObserveDemo  the lead cell: a real captured iOS frame, each element framed
//                as observe prints its line (the SDK's own line format)
//   TapDemo      a tap that changed nothing is reported; fixed, it goes through
//   GotoDemo     an app map: goto lights the path to a screen
//   SkillDemo    a recorded skill replaying its steps
//   AgentsDemo   any MCP client, through phone-use mcp, to either platform

import { Check, Smartphone } from 'lucide-react'
import type { Act } from './kit/act'
import { Phone } from './kit/phone'
import { Stage } from './kit/stage'
import './capabilities.css'

function Cmd({ children }: { children: string }) {
  return (
    <code className="cap-cmd">
      <span aria-hidden>❯</span>
      {children}
    </code>
  )
}

// ── observe ──────────────────────────────────────────────────────────────

// Rects in the device's points (390 × 844), measured from the captured frame
const ELEMENTS = [
  { ref: '@e1', role: 'Button', label: 'Close', r: [16, 48, 74, 42] },
  { ref: '@e2', role: 'StaticText', label: 'Trip Status', r: [152, 60, 87, 19] },
  { ref: '@e3', role: 'StaticText', label: 'Requesting', r: [29, 366, 116, 21] },
  { ref: '@e4', role: 'StaticText', label: 'ETA 1 min', r: [274, 364, 88, 30] },
  { ref: '@e5', role: 'StaticText', label: 'Home to Oracle Park', r: [29, 395, 141, 16] },
  { ref: '@e6', role: 'Button', label: 'Requesting', r: [16, 438, 87, 26], note: '(selected)' },
  { ref: '@e7', role: 'Button', label: 'Driver assigned', r: [111, 438, 111, 26] },
  { ref: '@e8', role: 'Button', label: 'Driver arriving', r: [231, 438, 104, 26] },
] as const

// The screen is 402pt wide; the capture is 390pt, drawn to cover it
const PT = 402 / 390
const PAD = 5

type ObserveS = { shown: number }

async function observeScript(a: Act<ObserveS>) {
  await a.wait(500)
  for (let i = 1; i <= ELEMENTS.length; i++) {
    await a.set({ shown: i })
    await a.wait(260)
  }
}

export function ObserveDemo() {
  return (
    <Stage
      width={745}
      height={392}
      compact={{ below: 600, width: 342, height: 470 }}
      initial={{ shown: 0 }}
      poster={{ shown: ELEMENTS.length }}
      script={observeScript}
      play="once"
      fill
      className="cap-observe"
    >
      {(s, _rect, layout) => {
        const els = layout === 'compact' ? ELEMENTS.slice(0, 5) : ELEMENTS
        return (
          <>
            <Phone width={layout === 'compact' ? 250 : 300} frame="pro" time="9:41" dark wallpaper="#000" className="cap-phone">
              {/* The real frame from a run, under the phone's own status bar */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/real-run.png" alt="" className="cap-shot" />
              {els.map((el, i) => (
                <span
                  key={el.ref}
                  className="cap-box"
                  data-on={s.shown > i || undefined}
                  style={{ left: el.r[0] * PT - PAD, top: el.r[1] * PT - PAD, width: el.r[2] * PT + PAD * 2, height: el.r[3] * PT + PAD * 2 }}
                />
              ))}
            </Phone>
            <div className="cap-tree">
              <Cmd>phone-use observe</Cmd>
              <div className="cap-tree-body">
                {els.map((el, i) => (
                  <div key={el.ref} className="cap-line" data-on={s.shown > i || undefined}>
                    <span className="cap-ref">{el.ref}</span> <span className="cap-dim">[{el.role}]</span> &quot;{el.label}&quot;
                    {layout === 'wide' && (
                      <span className="cap-dim">
                        {' '}
                        ({el.r[0]},{el.r[1]} {el.r[2]}x{el.r[3]}){'note' in el ? ` ${el.note}` : ''}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )
      }}
    </Stage>
  )
}

// ── tap ──────────────────────────────────────────────────────────────────

type TapS = { agreed: boolean; log: number }

const TAP_LOG = [
  { cmd: 'tap "Continue"', ok: false },
  { cmd: 'tap "Agree to terms"', ok: true },
  { cmd: 'tap "Continue"', ok: true },
] as const

async function tapScript(a: Act<TapS>) {
  await a.wait(500)
  await a.click({ at: 'continue', x: 0.7, y: 0.55 })
  await a.wait(160)
  await a.set({ log: 1 })
  await a.wait(900)
  await a.click({ at: 'agree', x: 0.5, y: 0.5 })
  await a.set({ agreed: true })
  await a.wait(240)
  await a.set({ log: 2 })
  await a.wait(700)
  await a.click({ at: 'continue', x: 0.7, y: 0.55 })
  await a.wait(160)
  await a.set({ log: 3 })
}

export function TapDemo() {
  return (
    <Stage
      width={372}
      height={300}
      initial={{ agreed: false, log: 0 }}
      poster={{ agreed: true, log: 3 }}
      script={tapScript}
      play="once"
      fill
      cursor={{ at: { x: 320, y: 40 }, style: 'touch' }}
      className="cap-tap"
    >
      {(s) => (
        <>
          <div className="cap-form">
            <div className="cap-form-cell">
              <span>Agree to terms</span>
              <span className="cap-switch" data-on={s.agreed || undefined} data-target="agree">
                <span />
              </span>
            </div>
            <div className="cap-continue" data-target="continue" data-ready={s.agreed || undefined}>
              Continue
            </div>
          </div>
          <ol className="cap-rows">
            {TAP_LOG.map((row, i) => (
              <li key={i} data-on={s.log > i || undefined}>
                <code>{row.cmd}</code>
                <span className="cap-pill" data-tone={row.ok ? 'ok' : 'warn'}>
                  {row.ok ? 'changed' : 'no change'}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Stage>
  )
}

// ── goto ─────────────────────────────────────────────────────────────────

// An app map: screens as nodes, taps as edges. Positions inside the map.
const NODE = { w: 80, h: 28 }
const NODES = {
  settings: { x: 0, y: 64, label: 'Settings' },
  general: { x: 116, y: 22, label: 'General' },
  display: { x: 116, y: 106, label: 'Display' },
  about: { x: 232, y: 0, label: 'About' },
  fonts: { x: 232, y: 44, label: 'Fonts' },
  dictionary: { x: 232, y: 88, label: 'Dictionary' },
  textsize: { x: 232, y: 132, label: 'Text Size' },
} as const
type NodeId = keyof typeof NODES
const EDGES: [NodeId, NodeId][] = [
  ['settings', 'general'],
  ['settings', 'display'],
  ['general', 'about'],
  ['general', 'fonts'],
  ['general', 'dictionary'],
  ['display', 'textsize'],
]
const PATH: NodeId[] = ['settings', 'general', 'fonts']

type GotoS = { step: number }

async function gotoScript(a: Act<GotoS>) {
  await a.wait(600)
  for (let i = 1; i <= PATH.length; i++) {
    await a.set({ step: i })
    await a.wait(i === 1 ? 300 : 520)
  }
  await a.set({ step: PATH.length + 1 })
}

function edgePath(from: NodeId, to: NodeId) {
  const a = NODES[from]
  const b = NODES[to]
  const x1 = a.x + NODE.w
  const y1 = a.y + NODE.h / 2
  const x2 = b.x
  const y2 = b.y + NODE.h / 2
  const mx = (x1 + x2) / 2
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
}

export function GotoDemo() {
  return (
    <Stage width={372} height={300} initial={{ step: 0 }} poster={{ step: PATH.length + 1 }} script={gotoScript} play="once" fill className="cap-goto">
      {(s) => {
        const lit = (id: NodeId) => PATH.indexOf(id) > -1 && PATH.indexOf(id) < s.step
        const litEdge = (f: NodeId, t: NodeId) => {
          const i = PATH.indexOf(f)
          return i > -1 && PATH[i + 1] === t && i + 1 < s.step
        }
        return (
          <>
            <div className="cap-dots" aria-hidden />
            <div className="cap-goto-head">
              <Cmd>phone-use goto &quot;Fonts&quot;</Cmd>
            </div>
            <div className="cap-map">
              <svg className="cap-edges" width="312" height="160" aria-hidden>
                {EDGES.map(([f, t]) => (
                  <path key={`${f}-${t}`} d={edgePath(f, t)} className="cap-edge" />
                ))}
                {EDGES.map(([f, t]) => (
                  <path key={`lit-${f}-${t}`} d={edgePath(f, t)} className="cap-edge-lit" pathLength={1} data-on={litEdge(f, t) || undefined} />
                ))}
              </svg>
              {(Object.keys(NODES) as NodeId[]).map((id) => (
                <span key={id} className="cap-node" data-on={lit(id) || undefined} style={{ left: NODES[id].x, top: NODES[id].y }}>
                  {NODES[id].label}
                </span>
              ))}
            </div>
            <div className="cap-arrived" data-on={s.step > PATH.length || undefined}>
              <span className="cap-check" aria-hidden>
                <Check size={11} strokeWidth={3} />
              </span>
              Arrived at Fonts
              <span className="cap-dim">0 model calls</span>
            </div>
          </>
        )
      }}
    </Stage>
  )
}

// ── skill ────────────────────────────────────────────────────────────────

// Step kinds as a skill records them (packages/phone-use/src/skills.ts)
const SKILL_STEPS = ['open_app "Mail"', 'tap "Compose"', 'fill "Weekly report"', 'tap "Send"', 'verify "Sent"'] as const

type SkillS = { done: number }

async function skillScript(a: Act<SkillS>) {
  await a.wait(600)
  for (let i = 1; i <= SKILL_STEPS.length; i++) {
    await a.set({ done: i })
    await a.wait(260)
  }
}

export function SkillDemo() {
  return (
    <Stage width={372} height={300} initial={{ done: 0 }} poster={{ done: SKILL_STEPS.length }} script={skillScript} play="once" fill className="cap-skill">
      {(s) => (
        <>
          <div className="cap-skill-head">
            <Cmd>phone-use skill run send-report</Cmd>
          </div>
          <ol className="cap-steps">
            {SKILL_STEPS.map((step, i) => (
              <li key={step} data-done={s.done > i || undefined}>
                <span className="cap-check" aria-hidden>
                  <Check size={11} strokeWidth={3} />
                </span>
                <code>{step}</code>
              </li>
            ))}
          </ol>
        </>
      )}
    </Stage>
  )
}

// ── agents ───────────────────────────────────────────────────────────────

// Any MCP client, through one server, to a phone on either platform.
// Positions in stage px; lines run between the chips' facing edges.
const CLIENTS = [
  { name: 'Claude Code', logo: '/logos/anthropic.svg', y: 20 },
  { name: 'Codex', logo: '/logos/codex.svg', y: 76 },
  { name: 'Cursor', logo: '/logos/cursor.svg', y: 132 },
  { name: 'Any MCP client', logo: '/logos/mcp.svg', y: 188 },
] as const
const PHONES = [
  { name: 'iOS simulator', y: 76 },
  { name: 'Android emulator', y: 132 },
] as const
const CHIP = { w: 176, h: 40 }
const HUB = { x: 300, y: 104, w: 150, h: 40 }
const RIGHT_X = 528

function link(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2
  return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
}

type AgentsS = { step: number }

async function agentsScript(a: Act<AgentsS>) {
  await a.wait(500)
  for (let i = 1; i <= 3; i++) {
    await a.set({ step: i })
    await a.wait(520)
  }
}

export function AgentsDemo() {
  return (
    <Stage width={745} height={260} compact={{ below: 600, width: 342, height: 268 }} initial={{ step: 0 }} poster={{ step: 3 }} script={agentsScript} play="once" fill className="cap-agents">
      {(s, rect, layout) => {
        if (layout === 'compact') {
          // Narrow: the same flow, top to bottom
          return (
            <div className="cap-agents-compact">
              <div className="cap-agents-row">
                {CLIENTS.map((c) => (
                  <span key={c.name} className="cap-chip">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.logo} alt="" width={16} height={16} />
                    {c.name}
                  </span>
                ))}
              </div>
              <span className="cap-stem" aria-hidden />
              <span className="cap-hub">phone-use mcp</span>
              <span className="cap-stem" aria-hidden />
              <div className="cap-agents-row">
                {PHONES.map((p) => (
                  <span key={p.name} className="cap-chip">
                    <Smartphone size={16} strokeWidth={1.75} aria-hidden />
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          )
        }
        // Chips hug their names, so each line starts at its chip's measured edge
        const edge = (name: string, fallback: number) => {
          const r = rect(name)
          return r.width ? r.x + r.width : fallback
        }
        const hubIn = { x: HUB.x, y: HUB.y + HUB.h / 2 }
        const hubOut = { x: HUB.x + HUB.w, y: HUB.y + HUB.h / 2 }
        return (
          <>
            <svg className="cap-links" width="745" height="260" aria-hidden>
              {CLIENTS.map((c) => (
                <path key={c.name} d={link(edge(`client-${c.name}`, 28 + CHIP.w), c.y + CHIP.h / 2, hubIn.x, hubIn.y)} pathLength={1} data-on={s.step >= 1 || undefined} />
              ))}
              {PHONES.map((p) => (
                <path key={p.name} d={link(hubOut.x, hubOut.y, RIGHT_X, p.y + CHIP.h / 2)} pathLength={1} data-on={s.step >= 3 || undefined} />
              ))}
            </svg>
            {CLIENTS.map((c) => (
              <span key={c.name} className="cap-chip" data-side="client" data-target={`client-${c.name}`} style={{ left: 28, top: c.y }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.logo} alt="" width={16} height={16} />
                {c.name}
              </span>
            ))}
            <span className="cap-hub" data-on={s.step >= 2 || undefined} style={{ left: HUB.x, top: HUB.y, width: HUB.w }}>
              phone-use mcp
            </span>
            {PHONES.map((p) => (
              <span key={p.name} className="cap-chip" data-side="phone" data-on={s.step >= 3 || undefined} style={{ left: RIGHT_X, top: p.y }}>
                <Smartphone size={16} strokeWidth={1.75} aria-hidden />
                {p.name}
              </span>
            ))}
          </>
        )
      }}
    </Stage>
  )
}
