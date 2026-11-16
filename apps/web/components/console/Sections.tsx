"use client";

// Everything that isn't the stage or the agent panel: the first run, the API
// key, Usage, the banners above the stage, and the shell grid.

import type { ReactNode } from "react";
import { deviceName, minutesAgo, type Platform, shortId, type Usage } from "../../lib/console";
import { CopyButton, Icon } from "./ui";

export function ConsoleShell({
  sidebar,
  panel,
  children,
}: {
  sidebar: ReactNode;
  panel?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`dash${panel ? " has-panel" : ""}`}>
      {sidebar}
      <main className="dash-main">{children}</main>
      {panel}
    </div>
  );
}

/** Zero phones: one sentence and one action. */
export function FirstRun({
  androidCloud,
  creating,
  onCreate,
}: {
  androidCloud: boolean;
  creating: Platform | null;
  onCreate: (p: Platform) => void;
}) {
  return (
    <section className="dash-center" aria-labelledby="dash-first-h">
      <h1 id="dash-first-h" tabIndex={-1}>
        Give your agent a phone
      </h1>
      <p>Start a phone, add its config to your agent, and watch it work here.</p>
      <div className="dash-row">
        <button type="button" className="dash-btn" onClick={() => onCreate("ios")} disabled={creating !== null}>
          {creating === "ios" ? "Starting…" : "New iPhone"}
        </button>
        {androidCloud && (
          <button type="button" className="dash-btn2" onClick={() => onCreate("android")} disabled={creating !== null}>
            {creating === "android" ? "Starting…" : "New Android phone"}
          </button>
        )}
      </div>
    </section>
  );
}

/** A terminal on this machine asked for a key (phone-use login). */
export function CliApprove({
  port,
  busy,
  onApprove,
  onDeny,
}: {
  port: string;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="dash-banner is-cli" role="region" aria-label="CLI sign-in">
      <div>
        <h2>Authorize the phone-use CLI?</h2>
        <p>
          A terminal on this machine (port {port}) is asking for an API key. Approving mints a fresh key, replacing any
          existing one, and hands it to the CLI.
        </p>
      </div>
      <div className="dash-row">
        <button type="button" className="dash-btn" onClick={onApprove} disabled={busy}>
          {busy ? "Handing off…" : "Approve"}
        </button>
        <button type="button" className="dash-btn2" onClick={onDeny}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function VerifyNote({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="dash-banner is-note" role="status">
      <p>We emailed you a verification link. Verify to create phones. Nothing arriving? Check spam, then contact us.</p>
      <button type="button" className="dash-iconbtn" aria-label="Dismiss" onClick={onDismiss}>
        {Icon.close}
      </button>
    </div>
  );
}

/** Shown to an account that is not approved for cloud phones: say so before a create is refused. */
export function WaitlistNote({ url }: { url: string }) {
  return (
    <div className="dash-banner is-note" role="status">
      <div>
        <h2>Cloud phones are on a waitlist</h2>
        <p>
          This account cannot create cloud phones yet. phone-use still works on your own machine with the local
          simulator, and that needs no account.
        </p>
      </div>
      <a className="dash-btn2 is-sm" href={url}>
        Join the waitlist
      </a>
    </div>
  );
}

export function SectionHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="dash-head">
      <h1 tabIndex={-1}>{title}</h1>
      <p>{children}</p>
    </header>
  );
}

export function KeysSection({
  apiBase,
  freshKey,
  keyCreatedAt,
  confirmRotate,
  onRotate,
  onGenerate,
  now,
}: {
  apiBase: string;
  freshKey: string;
  keyCreatedAt: number | null;
  confirmRotate: boolean;
  /** First call arms, second mints; the container owns the 4 s disarm. */
  onRotate: () => void;
  onGenerate: () => void;
  now: number;
}) {
  const login = "phone-use login\nphone-use create ios";
  const env = `export PHONE_USE_CLOUD_URL=${apiBase || "https://api.phoneuse.dev"}
export PHONE_USE_CLOUD_TOKEN=${freshKey || "pk_…"}
phone-use create ios`;
  return (
    <div className="dash-section">
      <SectionHead title="API key">
        Agents and the CLI send it as <code>PHONE_USE_CLOUD_TOKEN</code>.
      </SectionHead>
      <div className="dash-split">
        <section aria-labelledby="dash-key-h">
          <h2 id="dash-key-h" className="dash-subhead">
            Your key
          </h2>
          {freshKey ? (
            <div className="dash-keystate is-fresh">
              <p className="dash-once">
                Shown <strong>once</strong>. Store it somewhere safe; rotating again replaces it immediately.
              </p>
              <div className="dash-keybox">
                <code>{freshKey}</code>
                <CopyButton text={freshKey} ariaLabel="Copy API key" />
              </div>
            </div>
          ) : keyCreatedAt ? (
            <div className="dash-keystate">
              <div className="dash-keystate-body">
                <p>
                  Active key <span className="dash-muted">· created {minutesAgo(keyCreatedAt, now)}</span>
                </p>
                <code className="dash-keymask">pk_••••••••••••••••••••</code>
                <p className="dash-muted dash-small">Shown only once, when it was created. Rotating replaces it immediately.</p>
              </div>
              <button type="button" className={confirmRotate ? "dash-danger is-armed" : "dash-btn2"} onClick={onRotate}>
                {confirmRotate ? "Replace current key?" : "Rotate key"}
              </button>
            </div>
          ) : (
            <div className="dash-keystate">
              <p className="dash-muted">No key yet. You need one to use the CLI and SDK from anywhere.</p>
              <button type="button" className="dash-btn" onClick={onGenerate}>
                Generate key
              </button>
            </div>
          )}
        </section>

        <section aria-labelledby="dash-use-h">
          <h2 id="dash-use-h" className="dash-subhead">
            Use it
          </h2>
          <div className="dash-steps">
            <div>
              <div className="dash-step-head">
                <h3>From your terminal</h3>
                <CopyButton text={login} ariaLabel="Copy login commands" />
              </div>
              <p className="dash-muted">
                <code>phone-use login</code> opens this console to approve, then saves a new key on your machine. Approving
                replaces the current key.
              </p>
              <pre className="dash-pre dash-snippet">{login}</pre>
            </div>
            <div>
              <div className="dash-step-head">
                <h3>In scripts and CI</h3>
                <CopyButton text={env} ariaLabel="Copy environment variables" />
              </div>
              <p className="dash-muted">Set the key as an environment variable instead.</p>
              <pre className="dash-pre dash-snippet">{env}</pre>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Billed minutes per local day, by session end, for the last `days` days. */
function DailyMinutes({ usage, now, days = 14 }: { usage: Usage[]; now: number; days?: number }) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const cols = Array.from({ length: days }, (_, i) => {
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1 - i));
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    const ms = usage.filter((u) => u.ended_at >= from.getTime() && u.ended_at < to.getTime()).reduce((sum, u) => sum + u.billed_ms, 0);
    return { date: from, minutes: ms / 60000 };
  });
  const max = Math.max(0, ...cols.map((c) => c.minutes));
  const peak = cols.findIndex((c) => c.minutes === max && max > 0);
  const long = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  const short = (d: Date, i: number) => (i === 0 || d.getDate() === 1 ? long(d) : String(d.getDate()));
  const total = cols.reduce((sum, c) => sum + c.minutes, 0);
  return (
    <figure className="dash-chart">
      <figcaption>
        Minutes billed per day <span className="dash-muted">· last {days} days · {total.toFixed(1)} min</span>
      </figcaption>
      <div
        className="dash-chart-plot"
        role="img"
        aria-label={
          max > 0
            ? `Minutes billed per day over the last ${days} days, ${total.toFixed(1)} in total; the most was ${max.toFixed(1)} on ${long(cols[peak]!.date)}. Every session is listed in the table below.`
            : `No minutes billed in the last ${days} days.`
        }
      >
        {cols.map((c, i) => (
          <div key={c.date.getTime()} className="dash-chart-col">
            <span className="dash-chart-tip" aria-hidden="true">
              {long(c.date)} · {c.minutes.toFixed(1)} min
            </span>
            {i === peak && (
              <span className="dash-chart-value" aria-hidden="true">
                {max.toFixed(1)}
              </span>
            )}
            <i style={{ height: max > 0 ? `${(c.minutes / max) * 100}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="dash-chart-axis" aria-hidden="true">
        {cols.map((c, i) => (
          <span key={c.date.getTime()}>{short(c.date, i)}</span>
        ))}
      </div>
    </figure>
  );
}

export function UsageSection({ usage, running, now }: { usage: Usage[]; running: number; now: number }) {
  const minutes = usage.reduce((sum, row) => sum + row.billed_ms, 0) / 60000;
  return (
    <div className="dash-section">
      <SectionHead title="Usage">Billed per minute, from start to close.</SectionHead>
      <dl className="dash-figures">
        <div>
          <dt>Minutes billed</dt>
          <dd>{minutes.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{usage.length}</dd>
        </div>
        <div>
          <dt>Running now</dt>
          <dd>{running}</dd>
        </div>
      </dl>
      {usage.length === 0 ? (
        <p className="dash-muted">No sessions yet. Closed phones show up here with their billed minutes.</p>
      ) : (
        <>
          <DailyMinutes usage={usage} now={now} />
          <div className="dash-tablewrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th scope="col">Phone</th>
                  <th scope="col">Billed</th>
                  <th scope="col">Ended</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={row.sandbox_id}>
                    <td>
                      {row.platform ? `${deviceName({ platform: row.platform })} ` : ""}
                      <span className="dash-mono dash-muted">{shortId(row.sandbox_id)}</span>
                    </td>
                    <td className="dash-num">{(row.billed_ms / 60000).toFixed(1)} min</td>
                    <td className="dash-muted">{new Date(row.ended_at).toLocaleString()}</td>
                    <td className="dash-muted">{row.end_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
