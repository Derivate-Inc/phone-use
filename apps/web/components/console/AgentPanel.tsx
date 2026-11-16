"use client";

// The right panel shows one thing at a time: how to connect an agent until it
// acts, then what it did (the phone's real action log, GET
// /v1/sandboxes/:id/events) as plain lines, newest first.

import type { ReactNode } from "react";
import {
  type Client,
  clock,
  describeEvent,
  isAgentEvent,
  maskToken,
  mcpConfig,
  type PhoneEvent,
  type Sandbox,
  shellConfig,
  timeline,
} from "../../lib/console";
import { CopyButton } from "./ui";

export type PanelView = "activity" | "connect";

const EVENT_CAP = 2000;

const CLIENTS: Record<Client, { label: string; save: ReactNode }> = {
  claude: {
    label: "Claude Code",
    save: (
      <>
        Save it as <code>.mcp.json</code> in your project, then restart Claude Code.
      </>
    ),
  },
  cursor: {
    label: "Cursor",
    save: (
      <>
        Save it as <code>.cursor/mcp.json</code> in your project, then enable phone-use in Cursor’s MCP settings.
      </>
    ),
  },
  shell: {
    label: "Shell",
    save: (
      <>
        Paste it into a terminal with the CLI installed (<code>npm i -g phone-use</code>).
      </>
    ),
  },
};

/** "tap" + "“Track order”" → "Tap “Track order”". */
function sentence(e: PhoneEvent & { count: number }): string {
  if (e.method === "viewerInput") return "Your input from this console";
  const { verb, target } = describeEvent(e);
  const text = `${verb[0]!.toUpperCase()}${verb.slice(1)}${target ? ` ${target}` : ""}`;
  return e.count > 1 ? `${text} (${e.count}×)` : text;
}

export function AgentPanel({
  phone,
  now,
  events,
  view,
  onView,
  client,
  onClient,
  waitingSince,
}: {
  phone: Sandbox;
  now: number;
  /** undefined while the first fetch is in flight. */
  events: PhoneEvent[] | undefined;
  view: PanelView;
  onView: (v: PanelView) => void;
  client: Client;
  onClient: (c: Client) => void;
  /** When this panel started waiting for the agent; a hint shows after 30 s. */
  waitingSince: number;
}) {
  const acted = (events ?? []).some(isAgentEvent);
  const c = phone.connection;

  if (view === "activity") {
    return (
      <aside className="dash-panel" aria-labelledby="dash-panel-h">
        <div className="dash-panel-head">
          <h2 id="dash-panel-h">Activity</h2>
          <button type="button" className="dash-ghost is-sm" onClick={() => onView("connect")}>
            Connection
          </button>
        </div>
        {events === undefined ? (
          <p className="dash-muted">Loading…</p>
        ) : events.length === 0 ? (
          <p className="dash-muted">Nothing yet.</p>
        ) : (
          <>
            <ol className="dash-log">
              {timeline(events).map((e, i) => (
                <li key={`${e.ts}-${e.method}-${i}`}>
                  <time dateTime={new Date(e.ts).toISOString()}>{clock(e.ts)}</time>
                  <span>{sentence(e)}</span>
                </li>
              ))}
            </ol>
            {events.length >= EVENT_CAP && (
              <p className="dash-muted dash-small">Showing the first {EVENT_CAP.toLocaleString()} actions; newer ones may be missing.</p>
            )}
          </>
        )}
      </aside>
    );
  }

  return (
    <aside className="dash-panel" aria-labelledby="dash-panel-h">
      <div className="dash-panel-head">
        <h2 id="dash-panel-h">Connect your agent</h2>
        {acted && (
          <button type="button" className="dash-ghost is-sm" onClick={() => onView("activity")}>
            Activity
          </button>
        )}
      </div>
      {!c ? (
        <p className="dash-muted">
          {phone.status === "running" ? "Reconnecting to the phone…" : "The config appears when the phone is ready."}
        </p>
      ) : (
        <>
          <p className="dash-muted">Add this to your agent. The token stops working when the phone closes.</p>
          <div className="dash-clients" role="group" aria-label="Agent">
            {(Object.keys(CLIENTS) as Client[]).map((id) => (
              <button key={id} type="button" aria-pressed={client === id} onClick={() => onClient(id)}>
                {CLIENTS[id].label}
              </button>
            ))}
          </div>
          <div className="dash-code">
            <pre>
              {(() => {
                const shown = { endpoint: c.endpoint, token: maskToken(c.token) };
                return client === "shell" ? shellConfig(shown) : mcpConfig(shown);
              })()}
            </pre>
          </div>
          <CopyButton
            text={client === "shell" ? shellConfig(c) : mcpConfig(c)}
            className="dash-btn dash-copy-config"
            label="Copy config"
          />
          <p className="dash-muted dash-small">{CLIENTS[client].save}</p>
          {!acted && events !== undefined && (
            <p className="dash-waiting" role="status">
              <span className="dash-pulse" aria-hidden="true" />
              {now - waitingSince > 30_000
                ? "Still waiting. Restart your agent so it loads the config, then ask it to do something on the phone."
                : "Waiting for your agent’s first action…"}
            </p>
          )}
        </>
      )}
    </aside>
  );
}
