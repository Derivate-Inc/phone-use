"use client";

// The stage: the selected phone at the largest size the viewport allows, under
// a one-line header. The screen is a slot: the console passes LiveView, the
// fixtures page passes a still.

import { type ReactNode, useEffect } from "react";
import { deviceName, type Platform, type Sandbox, shortId, timeLeft } from "../../lib/console";
import { CopyButton, Icon } from "./ui";

/** A device frame with no stream yet: the real bezel, a dark screen, a thin progress line. */
function BootFrame({ platform, caption }: { platform: string; caption: string }) {
  return (
    <div className={`dash-live${platform === "android" ? " is-android" : ""}`}>
      <div className="dash-live-frame">
        <div className="dash-boot">
          <span className="logo-mark" aria-hidden="true">
            <i />
          </span>
          <span className="dash-boot-bar" aria-hidden="true">
            <i />
          </span>
        </div>
      </div>
      <p className="dash-live-note" role="status">
        {caption}
      </p>
    </div>
  );
}

export function PhoneStage({
  phone,
  now,
  screen,
  canControl,
  control,
  onControl,
  closeArmed,
  closing,
  onClose,
  onRetry,
  creating,
}: {
  phone: Sandbox;
  now: number;
  screen: ReactNode;
  canControl: boolean;
  control: boolean;
  onControl: (next: boolean) => void;
  closeArmed: boolean;
  closing: boolean;
  /** First call arms, second closes; the container owns the 4 s disarm. */
  onClose: () => void;
  /** A failed phone: start another of the same kind. */
  onRetry: () => void;
  creating: boolean;
}) {
  const running = phone.status === "running";
  const failed = phone.status === "failed" || phone.status === "error";
  const name = deviceName(phone);
  const msLeft = new Date(phone.expiresAt).getTime() - now;

  // Esc hands control back, wherever focus is.
  useEffect(() => {
    if (!control) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onControl(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [control, onControl]);

  let meta = phone.status;
  let body: ReactNode;
  if (failed) {
    meta = "failed";
    body = (
      <div className="dash-stage-note" role="alert">
        <h2>This {name} didn’t start</h2>
        <p>{phone.error ?? "It failed while starting."}</p>
        <button type="button" className="dash-btn" onClick={onRetry} disabled={creating}>
          {creating ? "Starting…" : `Start a new ${name}`}
        </button>
      </div>
    );
  } else if (phone.status === "queued") {
    const mins = phone.estimatedWaitMs ? Math.max(1, Math.round(phone.estimatedWaitMs / 60000)) : null;
    meta = phone.queuePosition ? `#${phone.queuePosition} in line` : "queued";
    body = <BootFrame platform={phone.platform} caption={mins ? `Waiting for a free phone, about ${mins} min` : "Waiting for a free phone"} />;
  } else if (phone.status === "preparing") {
    meta = "starting";
    body = <BootFrame platform={phone.platform} caption="Starting, usually a few seconds" />;
  } else if (phone.status === "draining") {
    meta = "closing";
    body = <BootFrame platform={phone.platform} caption="Closing" />;
  } else if (running && !phone.connection) {
    meta = "reconnecting";
    body = <BootFrame platform={phone.platform} caption="Reconnecting to the phone" />;
  } else {
    meta = timeLeft(phone.expiresAt, now);
    body = screen;
  }

  return (
    <section className={`dash-stage${control ? " is-controlling" : ""}`} aria-labelledby="dash-stage-h">
      <header className="dash-stage-head">
        <h1 id="dash-stage-h" tabIndex={-1}>
          {name}
        </h1>
        <span className="dash-stage-id">
          {shortId(phone.id)}
          <CopyButton text={phone.id} label={Icon.copy} className="dash-iconbtn is-sm" ariaLabel="Copy phone ID" />
        </span>
        <span className={`dash-stage-meta${running && msLeft < 5 * 60_000 ? " is-warn" : ""}`}>{meta}</span>
        <div className="dash-stage-actions">
          {canControl && (
            <button type="button" className="dash-btn2" aria-pressed={control} onClick={() => onControl(!control)}>
              {control ? "Hand back" : "Take control"}
            </button>
          )}
          {closing ? (
            <span className="dash-closing" role="status">
              Closing…
            </span>
          ) : (
            phone.status !== "draining" && (
              <button
                type="button"
                className={`dash-danger${closeArmed ? " is-armed" : ""}`}
                onClick={onClose}
                aria-describedby={closeArmed ? "dash-close-hint" : undefined}
              >
                {closeArmed ? "Confirm close" : failed ? "Dismiss" : "Close"}
              </button>
            )
          )}
          {closeArmed && (
            <span id="dash-close-hint" className="dash-visually-hidden">
              Click again to close this phone. Its connection token ends with it.
            </span>
          )}
        </div>
      </header>

      {control && (
        <p className="dash-control-banner" role="status">
          You’re controlling the phone. Your taps can interrupt the agent. <kbd>Esc</kbd> hands it back.
        </p>
      )}

      <div className="dash-stage-canvas">{body}</div>
    </section>
  );
}

/** After a close: what it cost and where the record lives. */
export function ClosedReceipt({
  phone,
  billedMinutes,
  actions,
  onUsage,
  onNew,
  creating,
}: {
  phone: { id: string; platform: string };
  /** From /v1/usage once the session row lands; null until then. */
  billedMinutes: number | null;
  actions: number;
  onUsage: () => void;
  onNew: (p: Platform) => void;
  creating: boolean;
}) {
  const name = deviceName(phone);
  return (
    <section className="dash-center" aria-labelledby="dash-receipt-h">
      <h1 id="dash-receipt-h" tabIndex={-1}>
        {name} closed
      </h1>
      <p>
        {billedMinutes === null ? "Counting billed minutes…" : `${billedMinutes.toFixed(1)} min billed`} · {actions} agent{" "}
        {actions === 1 ? "action" : "actions"}
      </p>
      <div className="dash-row">
        <button type="button" className="dash-btn" onClick={() => onNew(phone.platform === "android" ? "android" : "ios")} disabled={creating}>
          {creating ? "Starting…" : `New ${name}`}
        </button>
        <button type="button" className="dash-btn2" onClick={onUsage}>
          View usage
        </button>
      </div>
    </section>
  );
}
