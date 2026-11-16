"use client";

// Dev-only: every console state from static data, composed from the same parts
// as the live console. The screens are real phone captures; the phones,
// events and tokens below are made up for review and never reach production
// (app/dev/console 404s there).

import { useEffect } from "react";
import {
  deviceName,
  lastAgentAction,
  type PhoneEvent,
  type Platform,
  phoneState,
  type Sandbox,
  shortId,
  type Usage,
} from "../../lib/console";
import type { ThemeChoice } from "../../lib/theme";
import { AgentPanel } from "./AgentPanel";
import { ClosedReceipt, PhoneStage } from "./PhoneStage";
import { ConsoleShell, FirstRun, KeysSection, UsageSection, WaitlistFirstRun } from "./Sections";
import { type CreateFailure, type Section, Sidebar, type SidebarPhone } from "./Sidebar";

export type FixtureState =
  | "main"
  | "waiting"
  | "control"
  | "android"
  | "preparing"
  | "failed"
  | "armed"
  | "closed"
  | "empty"
  | "waitlist"
  | "keys"
  | "fresh-key"
  | "usage";

const NOW = Date.parse("2026-11-07T19:42:12Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();
const asset = (name: string) => `/dev/console/asset/${name}`;
const conn = (id: string) => ({
  endpoint: `https://ios-worker.example.com/v1/device/${id}`,
  token: "pst_5e0c2a91d47b4f8e9c3a6b1d0f7e3f9c",
});

const phone = (id: string, platform: Platform, status: string, upMin: number, extra: Partial<Sandbox> = {}): Sandbox => ({
  id,
  platform,
  status,
  createdAt: ago(upMin * MIN),
  expiresAt: ahead((60 - upMin) * MIN),
  ...(status === "running" ? { connection: conn(id) } : {}),
  ...extra,
});

const A = phone("sbx_7f3k2m9a4c1e48b2a6d03f5e9b8c7a10", "ios", "running", 12);
const B = phone("sbx_8c5f2022d9e14f7bb3a6c0e1f2d4a9b3", "android", "running", 8);
const C = phone("sbx_c41e0b77a2f34d6c9e8b1a0f3c5d7e92", "ios", "running", 29);
const D = phone("sbx_5d9a2f10b8c74e3a91f6d2c0e4a7b5c8", "ios", "preparing", 0);
const E = phone("sbx_e2b7c90d14a64c1f8a3e5d7b9c0f1a26", "ios", "running", 2);
const F = phone("sbx_f03a9d61c7e24b85a1d6e0c3b9f7a248", "ios", "failed", 1, {
  error: "The simulator didn’t finish booting. Start a new one; this one won’t recover.",
});

const ev = (secondsAgo: number, method: string, detail?: Record<string, unknown>): PhoneEvent => ({
  ts: NOW - secondsAgo * 1000,
  method,
  detail: detail ? JSON.stringify(detail) : null,
});

const EVENTS: Record<string, PhoneEvent[]> = {
  [A.id]: [
    ev(704, "openApp", { app: "Settings" }),
    ev(700, "snapshot"),
    ev(694, "press", { label: "General" }),
    ev(690, "home"),
    ev(64, "openApp", { app: "QuickBite" }),
    ev(61, "snapshot"),
    ev(58, "snapshot"),
    ev(55, "press", { label: "Chipotle Mexican Grill" }),
    ev(49, "press", { label: "Burrito Bowl" }),
    ev(44, "press", { label: "Add to order" }),
    ev(38, "press", { label: "Checkout" }),
    ev(31, "fill", { ref: "e14", textLength: 18 }),
    ev(24, "press", { label: "Place order" }),
    ev(19, "waitForText", { text: "Order confirmed" }),
    ev(12, "press", { label: "Track order" }),
    ev(9, "snapshot"),
    ev(7, "snapshot"),
    ev(4, "snapshot"),
  ],
  [B.id]: [ev(40, "openApp", { app: "Settings" }), ev(36, "snapshot"), ev(30, "press", { label: "Network & internet" }), ev(6, "snapshot")],
  [C.id]: [ev(1500, "openApp", { app: "Settings" }), ev(1490, "snapshot"), ev(240, "scroll", { arg: '{"direction":"down"}' })],
  [E.id]: [],
};

const THUMBS: Record<string, string> = {
  [A.id]: "tracking.jpg",
  [B.id]: "android-network.jpg",
  [C.id]: "settings.jpg",
  [E.id]: "settings.jpg",
};

// Two weeks of made-up sessions: [days ago, hour, minutes billed, platform, reason].
const SESSIONS: Array<[number, number, number, Platform, string]> = [
  [0, 9, 12.4, "ios", "closed"],
  [0, 7, 6.1, "android", "idle"],
  [1, 16, 41.7, "ios", "expired"],
  [1, 11, 8.2, "ios", "closed"],
  [2, 14, 15.0, "ios", "closed"],
  [3, 10, 3.4, "android", "closed"],
  [4, 15, 22.9, "ios", "idle"],
  [4, 9, 5.5, "ios", "closed"],
  [6, 13, 9.8, "ios", "closed"],
  [7, 17, 31.2, "ios", "expired"],
  [8, 12, 4.1, "android", "closed"],
  [9, 10, 18.6, "ios", "closed"],
  [11, 14, 7.3, "ios", "idle"],
  [12, 16, 12.0, "ios", "closed"],
];
const USAGE: Usage[] = SESSIONS.map(([daysAgo, hour, minutes, platform, reason], i) => {
  const ended = new Date(NOW);
  ended.setDate(ended.getDate() - daysAgo);
  ended.setHours(hour, 12 + i, 0, 0);
  return {
    sandbox_id: `sbx_${(0x9a1c3e5f7b2d + i * 7919).toString(16).padStart(12, "0")}${"0".repeat(20)}`,
    platform,
    billed_ms: minutes * MIN,
    ended_at: Math.min(ended.getTime(), NOW - 5 * MIN),
    end_reason: reason,
  };
});

/** LiveView's markup with a still instead of a stream. */
function LiveStill({ src, platform, control }: { src: string; platform: string; control?: boolean }) {
  return (
    <div className={`dash-live${platform === "android" ? " is-android" : ""}`}>
      <div className={`dash-live-frame${control ? " is-controlled" : ""}`}>
        <img src={src} alt={`Live screen of the ${deviceName({ platform })}`} />
      </div>
      <div className="dash-live-note">
        <span className="dash-live-state" role="status">
          <i aria-hidden="true" />
          {platform === "android" ? "Live screen · updating" : "Live video"}
        </span>
        {platform !== "android" && (
          <button type="button" className="dash-ghost is-sm">
            Use screenshots
          </button>
        )}
      </div>
      {control && (
        <div className="phone-controls">
          <div className="phone-control-buttons">
            <button type="button" className="dash-btn2">
              Home
            </button>
            <button type="button" className="dash-btn2">
              Return
            </button>
          </div>
          <form onSubmit={(event) => event.preventDefault()}>
            <input className="dash-input" aria-label="Text to paste on phone" placeholder="Text to paste" />
            <button className="dash-btn2" type="submit" disabled>
              Paste
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

const noop = () => undefined;

export function ConsoleFixtures({ state, theme }: { state: FixtureState; theme: ThemeChoice }) {
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  const list: Sandbox[] =
    state === "empty" || state === "waitlist"
      ? []
      : state === "waiting"
        ? [E, A, B]
        : state === "failed"
          ? [F, A, C]
          : state === "closed"
            ? [B, C]
            : [A, B, C, D];
  const selected: Sandbox | null =
    state === "waiting"
      ? E
      : state === "android"
        ? B
        : state === "preparing"
          ? D
          : state === "failed"
            ? F
            : state === "closed" || state === "empty" || state === "waitlist"
              ? null
              : A;
  const section: Section = state === "keys" || state === "fresh-key" ? "keys" : state === "usage" ? "usage" : "phones";
  const createFailure: CreateFailure | null = state === "main" ? { platform: "ios", message: "Rate limit: too many creates." } : null;

  const phones: SidebarPhone[] = list.map((s) => {
    const last = s.status === "running" ? lastAgentAction(EVENTS[s.id] ?? []) : undefined;
    const st = phoneState(s, last, NOW);
    return {
      id: s.id,
      platform: s.platform,
      name: deviceName(s),
      short: shortId(s.id).slice(0, 4),
      word: st.word,
      tone: st.tone,
      thumb: THUMBS[s.id] ? <img src={asset(THUMBS[s.id]!)} alt="" /> : null,
      booting: s.status === "queued" || s.status === "preparing",
    };
  });

  const control = state === "control";
  let main: React.ReactNode;
  if (section === "keys") {
    main = (
      <KeysSection
        apiBase=""
        freshKey={state === "fresh-key" ? "pk_fixtureKeyOnlyForScreenshots_0000000" : ""}
        keyCreatedAt={NOW - 3 * 24 * 60 * MIN} confirmRotate={false} onRotate={noop} onGenerate={noop} now={NOW} />
    );
  } else if (section === "usage") {
    main = <UsageSection usage={USAGE} running={3} now={NOW} />;
  } else if (state === "closed") {
    main = <ClosedReceipt phone={A} billedMinutes={12.4} actions={18} onUsage={noop} onNew={noop} creating={false} />;
  } else if (state === "empty") {
    main = <FirstRun androidCloud creating={null} onCreate={noop} />;
  } else if (state === "waitlist") {
    main = <WaitlistFirstRun url="https://phoneuse.dev/waitlist" />;
  } else if (selected) {
    main = (
      <PhoneStage
        phone={selected}
        now={NOW}
        screen={THUMBS[selected.id] ? <LiveStill src={asset(THUMBS[selected.id]!)} platform={selected.platform} control={control} /> : null}
        canControl={selected.platform === "ios" && selected.status === "running"}
        control={control}
        onControl={noop}
        closeArmed={state === "armed"}
        closing={false}
        onClose={noop}
        onRetry={noop}
        creating={false}
      />
    );
  }

  const showPanel = section === "phones" && selected !== null && ["running", "preparing", "queued"].includes(selected.status);
  const events = selected ? (EVENTS[selected.id] ?? []) : [];

  return (
    <>
      {/* Set the theme before first paint so a screenshot never catches the system theme. */}
      {theme !== "system" && <script dangerouslySetInnerHTML={{ __html: `document.documentElement.dataset.theme=${JSON.stringify(theme)}` }} />}
      <ConsoleShell
      sidebar={
        <Sidebar
          section={section}
          onSection={noop}
          phones={phones}
          loaded
          selectedId={section === "phones" ? (selected?.id ?? null) : null}
          onSelect={noop}
          androidCloud
          canCreate={state !== "waitlist"}
          creating={null}
          onCreate={noop}
          createFailure={createFailure}
          onDismissFailure={noop}
          who="Ada Lovelace"
          dark={theme === "dark"}
          onToggleTheme={noop}
          onSignOut={noop}
        />
      }
      panel={
        showPanel && selected ? (
          <AgentPanel
            phone={selected}
            now={NOW}
            events={selected.status === "running" ? events : []}
            view={state === "waiting" || state === "preparing" ? "connect" : "activity"}
            onView={noop}
            client="claude"
            onClient={noop}
            waitingSince={NOW - 45_000}
          />
        ) : undefined
      }
    >
      {main}
      </ConsoleShell>
    </>
  );
}
