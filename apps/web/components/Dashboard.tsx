"use client";

// The cloud console (app.phoneuse.dev) over the control plane at
// NEXT_PUBLIC_PHONE_USE_API. This file owns data, polling and selection; the
// look lives in components/console/*, which app/dev/console renders with
// static data for review. Sessions are Better Auth cookies (humans); minted
// API keys serve agents and the CLI.
//
// Direction contract (Impeccable):
// THESIS: the live phone is the product. Three quiet panes: your phones, the
//   one you're watching at full height, and one panel that shows either how
//   to connect an agent or what it did. Everything else earns its place or goes.
// OWN-WORLD: DESIGN.md's canon (Geist, hairlines, ink primaries, violet only
//   for links and focus) in light and dark; no status dots, words carry state.
// STORY: start a phone, copy its config into the agent, watch it work.
// FIRST VIEWPORT: sidebar of phones (thumbnail, name, one word); a one-line
//   stage header over the full-height screen; the panel on the right.
// FORM: the merged prototype, distilled at the owner's request.
// FINISH: unreviewed and undocumented is unfinished; this build ends with the
//   finish review, the verdict, and DESIGN.md.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Client,
  deviceName,
  isActive,
  isAgentEvent,
  lastAgentAction,
  type PhoneEvent,
  type Platform,
  phoneState,
  type Sandbox,
  shortId,
  type Usage,
} from "../lib/console";
import { useStreamThumb } from "../lib/stream-thumb";
import { useTheme } from "../lib/theme";
import { AgentPanel, type PanelView } from "./console/AgentPanel";
import { AuthScreen, type Me } from "./console/AuthScreen";
import { ClosedReceipt, PhoneStage } from "./console/PhoneStage";
import {
  CliApprove,
  ConsoleShell,
  FirstRun,
  KeysSection,
  UsageSection,
  VerifyNote,
  WaitlistFirstRun,
  WaitlistNote,
} from "./console/Sections";
import { type CreateFailure, type Section, Sidebar, type SidebarPhone } from "./console/Sidebar";
import LiveView from "./LiveView";

// Same-origin by default: /v1 and /api/auth are proxied to the control plane
// by next.config rewrites. Set NEXT_PUBLIC_PHONE_USE_API for a direct API.
const API = process.env.NEXT_PUBLIC_PHONE_USE_API ?? "";
// The Android option appears only once an Android worker is deployed
// (NEXT_PUBLIC_ANDROID_CLOUD=1); until then a click would just 503.
const ANDROID_CLOUD = process.env.NEXT_PUBLIC_ANDROID_CLOUD === "1";

/** "no android capacity available yet" → "No android capacity available yet." */
const sentence = (message: string): string => {
  const text = message.trim();
  if (!text) return "Something went wrong.";
  return `${text[0]!.toUpperCase()}${text.slice(1)}${/[.!?…]$/.test(text) ? "" : "."}`;
};

const nameOf = (me: Me): string => (me.isAdmin ? "Admin" : (me.name ?? "Account"));

/** The waitlist link for an account that is not approved for cloud phones, else null. */
const waitlistOf = (me: Me): string | null =>
  me.cloudApproved === false ? (me.waitlistUrl ?? "https://phoneuse.dev/waitlist") : null;

/** A sidebar still, refreshed only right after the agent acts (see useStreamThumb). */
function LiveThumb({ phone, lastAgentAt, now }: { phone: Sandbox; lastAgentAt: number | null | undefined; now: number }) {
  const key = typeof lastAgentAt === "number" && now - lastAgentAt < 60_000 ? Math.floor(lastAgentAt / 15_000) : undefined;
  const src = useStreamThumb(phone.status === "running" ? phone.connection : undefined, key);
  return src ? <img src={src} alt="" /> : null;
}

export function Dashboard() {
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [who, setWho] = useState("");
  const [keyCreatedAt, setKeyCreatedAt] = useState<number | null>(null);
  const [waitlistUrl, setWaitlistUrl] = useState<string | null>(null);
  const [justSignedUp, setJustSignedUp] = useState(false);
  const [theme, setTheme] = useTheme();
  // The toggle shows what you see, so "system" resolves through the media query.
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);

  const [section, setSection] = useState<Section>("phones");
  const [fleet, setFleet] = useState<Sandbox[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [events, setEvents] = useState<Record<string, PhoneEvent[]>>({});
  const [now, setNow] = useState(() => Date.now());

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ phone: Sandbox; actions: number } | null>(null);
  const [creating, setCreating] = useState<Platform | null>(null);
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
  // Two-step guards: first click arms, second click fires. Auto-disarm.
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [control, setControl] = useState(false);
  const [tabChoice, setTabChoice] = useState<Record<string, PanelView>>({});
  const [client, setClient] = useState<Client>("claude");
  const [waitingSince, setWaitingSince] = useState<Record<string, number>>({});

  const [freshKey, setFreshKey] = useState("");
  const [error, setError] = useState("");
  const [cliPort, setCliPort] = useState<string | null>(null);
  const [cliState, setCliState] = useState("");
  const [cliBusy, setCliBusy] = useState(false);

  useEffect(() => {
    // Strictly a port number: anything else (e.g. "80@evil.com") would turn the
    // key handoff redirect into an exfiltration vector.
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("cli");
    const state = params.get("state") ?? "";
    setCliPort(raw && /^\d{2,5}$/.test(raw) ? raw : null);
    setCliState(/^[a-f0-9]{16,64}$/i.test(state) ? state : "");
  }, []);

  // Section lives in the URL: ?section=keys survives refresh, Back walks
  // sections instead of exiting the app.
  useEffect(() => {
    const fromUrl = () => {
      const s = new URLSearchParams(window.location.search).get("section");
      setSection(s === "keys" || s === "usage" ? s : "phones");
    };
    fromUrl();
    window.addEventListener("popstate", fromUrl);
    return () => window.removeEventListener("popstate", fromUrl);
  }, []);

  const go = useCallback((id: Section) => {
    setSection(id);
    const query = new URLSearchParams(window.location.search);
    if (id === "phones") query.delete("section");
    else query.set("section", id);
    const qs = query.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) history.pushState(null, "", next);
  }, []);

  useEffect(() => {
    if (!confirmCloseId && !confirmRotate) return;
    const t = setTimeout(() => {
      setConfirmCloseId(null);
      setConfirmRotate(false);
    }, 4000);
    return () => clearTimeout(t);
  }, [confirmCloseId, confirmRotate]);

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (response.status === 401) {
      setAuthed(false);
      throw new Error("signed out");
    }
    if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
    return body;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, usageBody] = await Promise.all([
        api<Sandbox[]>("/v1/sandboxes"),
        api<{ usage: Usage[] }>("/v1/usage"),
      ]);
      setFleet(list);
      setUsage(usageBody.usage ?? []);
      setLoaded(true);
      setNow(Date.now());
    } catch {
      /* transient: the next poll retries */
    }
  }, [api]);

  useEffect(() => {
    void api<Me>("/v1/me")
      .then((me) => {
        setWho(nameOf(me));
        setKeyCreatedAt(me.keyCreatedAt ?? null);
        setWaitlistUrl(waitlistOf(me));
        setAuthed(true);
        void refresh();
      })
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, [api, refresh]);

  useEffect(() => {
    if (!authed) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [authed, refresh]);

  const active = useMemo(() => fleet.filter(isActive), [fleet]);
  // The picked phone while it's active; otherwise the newest running one. A
  // close receipt holds the stage until the person picks or creates a phone.
  const selected = receipt
    ? null
    : (active.find((s) => s.id === pickedId) ?? active.find((s) => s.status === "running") ?? active[0] ?? null);
  const selectedId = selected?.id ?? null;

  // The action log: the watched phone every 3 s, the others every 9 s, only
  // while this tab is visible. Phones that aren't running have none to show.
  const runningIds = useMemo(
    () =>
      fleet
        .filter((s) => s.status === "running")
        .map((s) => s.id)
        .join(","),
    [fleet],
  );
  useEffect(() => {
    if (!authed || !runningIds) return;
    const ids = runningIds.split(",");
    let tick = 0;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      for (const id of ids) {
        if (id !== selectedId && tick % 3 !== 0) continue;
        api<{ events: PhoneEvent[] }>(`/v1/sandboxes/${encodeURIComponent(id)}/events`)
          .then(({ events: list }) =>
            setEvents((prev) => {
              const old = prev[id];
              if (old && old.length === list.length && old[old.length - 1]?.ts === list[list.length - 1]?.ts) return prev;
              return { ...prev, [id]: list };
            }),
          )
          .catch(() => undefined);
      }
      tick += 1;
    };
    run();
    const t = setInterval(run, 3000);
    return () => clearInterval(t);
  }, [authed, runningIds, selectedId, api]);

  // A different phone on stage starts in view-only mode (selectedId is the
  // trigger, not an input).
  useEffect(() => {
    setControl(false);
  }, [selectedId]);

  // The connect panel's 30 s troubleshooting clock starts when a running phone
  // with no agent first reaches the stage.
  const selectedLast = lastAgentAction(selected ? events[selected.id] : undefined);
  const awaitingAgent = selected?.status === "running" && selectedLast === null;
  useEffect(() => {
    if (!awaitingAgent || !selectedId) return;
    setWaitingSince((prev) => (prev[selectedId] ? prev : { ...prev, [selectedId]: Date.now() }));
  }, [awaitingAgent, selectedId]);

  async function create(p: Platform) {
    setCreating(p);
    setCreateFailure(null);
    try {
      const made = await api<Sandbox>("/v1/sandboxes", { method: "POST", body: JSON.stringify({ platform: p }) });
      setReceipt(null);
      if (made?.id) setPickedId(made.id);
      go("phones");
      await refresh();
    } catch (cause) {
      const message = (cause as Error).message;
      if (message !== "signed out") setCreateFailure({ platform: p, message: sentence(message) });
    }
    setCreating(null);
  }

  async function closePhone(id: string) {
    setConfirmCloseId(null);
    setClosingIds((prev) => new Set(prev).add(id));
    const phone = fleet.find((s) => s.id === id);
    try {
      await api(`/v1/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (phone && phone.status !== "failed" && phone.status !== "error" && id === selectedId) {
        setReceipt({ phone, actions: (events[id] ?? []).filter(isAgentEvent).length });
      }
      setControl(false);
      await refresh();
    } catch (cause) {
      setError(sentence((cause as Error).message));
    }
    setClosingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function mintKey() {
    setError("");
    try {
      const { key } = await api<{ key: string }>("/v1/keys/rotate", { method: "POST" });
      setFreshKey(key);
      setKeyCreatedAt(Date.now());
    } catch (cause) {
      setError(sentence((cause as Error).message));
    }
  }

  async function approveCli() {
    setCliBusy(true);
    try {
      const { key } = await api<{ key: string }>("/v1/keys/rotate", { method: "POST" });
      window.location.href = `http://127.0.0.1:${cliPort}/callback?key=${encodeURIComponent(key)}&state=${encodeURIComponent(cliState)}`;
    } catch (cause) {
      setError(sentence((cause as Error).message));
      setCliBusy(false);
    }
  }

  async function signOut() {
    await fetch(`${API}/api/auth/sign-out`, { method: "POST", credentials: "include" }).catch(() => undefined);
    location.reload();
  }

  const onControl = useCallback((next: boolean) => setControl(next), []);

  // ── auth ────────────────────────────────────────────────────────────────
  // Until the session probe answers, render nothing: painting the sign-in
  // form first gives logged-in users a one-frame flash of the wrong screen.
  if (!checked) return <div className="dash-auth-split" aria-hidden="true" />;
  if (!authed) {
    return (
      <AuthScreen
        api={API}
        onSignedIn={(me, signedUp) => {
          setWho(nameOf(me));
          setKeyCreatedAt(me.keyCreatedAt ?? null);
          setWaitlistUrl(waitlistOf(me));
          if (signedUp) setJustSignedUp(true);
          setAuthed(true);
          void refresh();
        }}
      />
    );
  }

  // ── console ─────────────────────────────────────────────────────────────
  const sidebarPhones: SidebarPhone[] = active.map((s) => {
    const last = s.status === "running" ? lastAgentAction(events[s.id]) : undefined;
    const state = phoneState(s, last, now);
    return {
      id: s.id,
      platform: s.platform,
      name: deviceName(s),
      short: shortId(s.id).slice(0, 4),
      word: closingIds.has(s.id) ? "closing" : state.word,
      tone: closingIds.has(s.id) ? "wait" : state.tone,
      thumb: <LiveThumb phone={s} lastAgentAt={last} now={now} />,
      booting: s.status === "queued" || s.status === "preparing",
    };
  });

  const banners = (
    <>
      {cliPort && <CliApprove port={cliPort} busy={cliBusy} onApprove={approveCli} onDeny={() => setCliPort(null)} />}
      {/* On the phones section the whole page is the waitlist notice, so the banner is for the other sections. */}
      {waitlistUrl && section !== "phones" && <WaitlistNote url={waitlistUrl} />}
      {justSignedUp && !waitlistUrl && <VerifyNote onDismiss={() => setJustSignedUp(false)} />}
      {error && (
        <div className="dash-banner is-error" role="alert">
          <p>{error}</p>
          <button type="button" className="dash-ghost is-sm" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );

  const canControl = selected?.platform === "ios" && selected.status === "running" && Boolean(selected.connection);
  const tab: PanelView =
    (selected && tabChoice[selected.id]) ??
    (selected?.status !== "running" || selectedLast === null ? "connect" : "activity");
  const showPanel =
    section === "phones" && selected !== null && ["running", "preparing", "queued"].includes(selected.status);

  let main: React.ReactNode;
  if (section === "keys") {
    main = (
      <KeysSection
        apiBase={API}
        freshKey={freshKey}
        keyCreatedAt={keyCreatedAt}
        confirmRotate={confirmRotate}
        now={now}
        onGenerate={() => void mintKey()}
        onRotate={() => {
          if (confirmRotate) {
            setConfirmRotate(false);
            void mintKey();
          } else setConfirmRotate(true);
        }}
      />
    );
  } else if (section === "usage") {
    main = <UsageSection usage={usage} running={active.filter((s) => s.status === "running").length} now={now} />;
  } else if (!loaded) {
    main = (
      <div className="dash-stage-skeleton" aria-hidden="true">
        <i />
        <i />
      </div>
    );
  } else if (receipt) {
    const row = usage.find((u) => u.sandbox_id === receipt.phone.id);
    main = (
      <ClosedReceipt
        phone={receipt.phone}
        billedMinutes={row ? row.billed_ms / 60000 : null}
        actions={receipt.actions}
        onUsage={() => go("usage")}
        onNew={(p) => void create(p)}
        creating={creating !== null}
      />
    );
  } else if (selected) {
    main = (
      <PhoneStage
        phone={selected}
        now={now}
        screen={
          selected.connection ? (
            <LiveView
              key={selected.id}
              endpoint={selected.connection.endpoint}
              token={selected.connection.token}
              platform={selected.platform}
              control={canControl ? control : undefined}
            />
          ) : null
        }
        canControl={canControl}
        control={control}
        onControl={onControl}
        closeArmed={confirmCloseId === selected.id}
        closing={closingIds.has(selected.id)}
        onClose={() => (confirmCloseId === selected.id ? void closePhone(selected.id) : setConfirmCloseId(selected.id))}
        onRetry={() => void create(selected.platform === "android" ? "android" : "ios")}
        creating={creating !== null}
      />
    );
  } else {
    main = waitlistUrl ? (
      <WaitlistFirstRun url={waitlistUrl} />
    ) : (
      <FirstRun androidCloud={ANDROID_CLOUD} creating={creating} onCreate={(p) => void create(p)} />
    );
  }

  return (
    <ConsoleShell
      sidebar={
        <Sidebar
          section={section}
          onSection={go}
          phones={sidebarPhones}
          loaded={loaded}
          selectedId={section === "phones" ? selectedId : null}
          onSelect={(id) => {
            setReceipt(null);
            setPickedId(id);
            go("phones");
          }}
          androidCloud={ANDROID_CLOUD}
          canCreate={!waitlistUrl}
          creating={creating}
          onCreate={(p) => void create(p)}
          createFailure={createFailure}
          onDismissFailure={() => setCreateFailure(null)}
          who={who}
          dark={dark}
          onToggleTheme={() => {
            // Landing on the system's own theme clears the saved choice, so the
            // console follows the system again instead of pinning it forever.
            const next = dark ? "light" : "dark";
            setTheme((next === "dark") === systemDark ? "system" : next);
          }}
          onSignOut={signOut}
        />
      }
      panel={
        showPanel && selected ? (
          <AgentPanel
            phone={selected}
            now={now}
            events={selected.status === "running" ? events[selected.id] : []}
            view={tab}
            onView={(v) => setTabChoice((prev) => ({ ...prev, [selected.id]: v }))}
            client={client}
            onClient={setClient}
            waitingSince={waitingSince[selected.id] ?? now}
          />
        ) : undefined
      }
    >
      {banners}
      {main}
    </ConsoleShell>
  );
}
