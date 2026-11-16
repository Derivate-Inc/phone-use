// Shared types and formatting for the console. No React here, so the fixtures
// page and the live console format phones and events identically.

export type Sandbox = {
  id: string;
  platform: string;
  status: string;
  queuePosition?: number;
  estimatedWaitMs?: number;
  createdAt: string;
  expiresAt: string;
  lastActiveAt?: string;
  error?: string;
  connection?: { endpoint: string; token: string };
};

/** A closed session from GET /v1/usage (the API returns the whole usage row). */
export type Usage = {
  sandbox_id: string;
  billed_ms: number;
  ended_at: number;
  end_reason: string;
  platform?: string;
  started_at?: number;
};

/** One device call, from GET /v1/sandboxes/:id/events (worker-recorded, redacted). */
export type PhoneEvent = { ts: number; method: string; detail: string | null };

export type Client = "claude" | "cursor" | "shell";

export type Platform = "ios" | "android";

export type Tone = "ok" | "wait" | "bad" | "idle";

export const deviceName = (s: { platform: string }): string =>
  s.platform === "android" ? "Android phone" : "iPhone";

export const osName = (s: { platform: string }): string => (s.platform === "android" ? "Android" : "iOS");

export const shortId = (id: string): string => id.slice(4, 16);

/** Closed and errored phones belong to Usage, not to the phone list. */
export const isActive = (s: Sandbox): boolean => s.status !== "closed" && s.status !== "error";

export function minutesAgo(ms: number, now = Date.now()): string {
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

export function upFor(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `up ${mins} min`;
  return `up ${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function timeLeft(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

export function secondsAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Viewer input comes from a person in the console, not from the agent. */
export const isAgentEvent = (e: PhoneEvent): boolean => e.method !== "viewerInput";

/** Time of the agent's latest action: undefined while unknown, null when it has never acted. */
export function lastAgentAction(events: PhoneEvent[] | undefined): number | null | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) if (isAgentEvent(events[i]!)) return events[i]!.ts;
  return null;
}

/**
 * The phone's state in the words the sidebar uses. "live" is reserved for the
 * video stream; the sidebar says what the phone is doing. `lastAgentAt` is
 * undefined while the action log is still loading, null when no agent has acted.
 */
export function phoneState(s: Sandbox, lastAgentAt: number | null | undefined, now = Date.now()): { word: string; tone: Tone } {
  if (s.status === "queued") return { word: s.queuePosition ? `#${s.queuePosition} in line` : "queued", tone: "wait" };
  if (s.status === "preparing") return { word: "starting", tone: "wait" };
  if (s.status === "draining") return { word: "closing", tone: "wait" };
  if (s.status === "failed" || s.status === "error") return { word: "failed", tone: "bad" };
  if (s.status !== "running") return { word: s.status, tone: "idle" };
  if (lastAgentAt === undefined) return { word: "running", tone: "idle" };
  if (lastAgentAt === null) return { word: "no agent yet", tone: "idle" };
  return now - lastAgentAt < 30_000 ? { word: "working", tone: "ok" } : { word: "idle", tone: "idle" };
}

type Parsed = Record<string, unknown>;
const parse = (detail: string | null): Parsed => {
  if (!detail) return {};
  try {
    const value = JSON.parse(detail) as unknown;
    return value && typeof value === "object" ? (value as Parsed) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** A device call in plain words: a verb and what it acted on. */
export function describeEvent(e: PhoneEvent): { verb: string; target: string } {
  const d = parse(e.detail);
  switch (e.method) {
    case "press":
    case "longPress": {
      const verb = e.method === "press" ? "tap" : "long-press";
      const label = str(d.label);
      if (label) return { verb, target: `“${label}”` };
      if (str(d.ref)) return { verb, target: `element ${d.ref}` };
      if (typeof d.x === "number" && typeof d.y === "number") return { verb, target: `point ${Math.round(d.x)}, ${Math.round(d.y)}` };
      return { verb, target: "" };
    }
    case "fill":
      return { verb: "type", target: `${Number(d.textLength) || 0} characters into ${str(d.ref) ?? "a field"}` };
    case "typeText":
      return { verb: "type", target: `${Number(d.textLength) || 0} characters` };
    case "pressKey":
      return { verb: "press key", target: str(d.arg) ?? "" };
    case "scroll": {
      const arg = str(d.arg) ?? "";
      const dir = /"direction":"(\w+)"/.exec(arg)?.[1] ?? arg.replace(/[{}"]/g, "");
      return { verb: "scroll", target: dir };
    }
    case "pan":
      return { verb: "swipe", target: "" };
    case "openApp":
      return { verb: "open", target: str(d.app) ?? str(d.url) ?? "" };
    case "waitForText":
      return { verb: "wait for", target: str(d.text) ? `“${d.text}”` : "" };
    case "snapshot":
      return { verb: "read the screen", target: "" };
    case "screenshot":
      return { verb: "screenshot", target: "" };
    case "home":
      return { verb: "go home", target: "" };
    case "back":
      return { verb: "go back", target: "" };
    case "systemAlert":
      return { verb: "answer an alert", target: "" };
    case "installApp":
      return { verb: "install an app", target: "" };
    case "listApps":
      return { verb: "list apps", target: "" };
    case "checkpoint":
      return { verb: "save checkpoint", target: str(d.label) ?? "" };
    case "restoreCheckpoint":
      return { verb: "restore checkpoint", target: str(d.checkpoint) ?? "" };
    case "deleteCheckpoint":
      return { verb: "delete checkpoint", target: str(d.checkpoint) ?? "" };
    case "listCheckpoints":
      return { verb: "list checkpoints", target: "" };
    case "closeSession":
      return { verb: "end session", target: "" };
    case "viewerInput":
      return { verb: "you", target: "input from this console" };
    default:
      return { verb: e.method, target: "" };
  }
}

/** Newest first, with runs of the same screen read folded into one row. */
export function timeline(events: PhoneEvent[], limit = 60): Array<PhoneEvent & { count: number }> {
  const out: Array<PhoneEvent & { count: number }> = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]!;
    const last = out[out.length - 1];
    if (last && (e.method === "snapshot" || e.method === "screenshot") && last.method === e.method) {
      last.count += 1;
      continue;
    }
    out.push({ ...e, count: 1 });
  }
  return out;
}

export function mcpConfig(c: { endpoint: string; token: string }): string {
  return `{
  "mcpServers": {
    "phone-use": {
      "command": "npx",
      "args": ["-y", "phone-use", "mcp"],
      "env": {
        "PHONE_USE_SANDBOX_URL": "${c.endpoint}",
        "PHONE_USE_SANDBOX_TOKEN": "${c.token}"
      }
    }
  }
}`;
}

export function shellConfig(c: { endpoint: string; token: string }): string {
  return `export PHONE_USE_SANDBOX_URL=${c.endpoint}
export PHONE_USE_SANDBOX_TOKEN=${c.token}
phone-use observe`;
}

export const maskToken = (token: string): string =>
  token.length <= 8 ? "••••••••" : `${token.slice(0, 4)}${"•".repeat(12)}${token.slice(-4)}`;
