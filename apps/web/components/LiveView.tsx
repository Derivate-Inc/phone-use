"use client";

import { useEffect, useRef, useState } from "react";
import { subscribeLiveStream, type StreamMode } from "../lib/live-stream";
import { useViewerControls } from "../lib/viewer-controls";
import { subscribeVideo } from "../lib/video-stream";

export default function LiveView({
  endpoint,
  token,
  interactive = false,
  control,
  platform = "ios",
}: {
  endpoint: string;
  token: string;
  /** The /phones viewer: an Enable controls toggle under the screen. */
  interactive?: boolean;
  /** The console stage: control follows its Take control button instead. */
  control?: boolean;
  platform?: string;
}) {
  // H.264 video exists only on iOS workers (an Android worker answers 501), so
  // an Android phone shows its screen stream from the start, with no toggle.
  const hasVideo = platform === "ios";
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(!hasVideo);
  const [frame, setFrame] = useState("");
  const [mode, setMode] = useState<StreamMode>("connecting");
  const [status, setStatus] = useState("Connecting video…");
  const [visible, setVisible] = useState(true);
  const [text, setText] = useState("");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!visible) { setStatus("Video paused · tab hidden"); return; }
    if (fallback) {
      setFrame("");
      return subscribeLiveStream(endpoint, token, setFrame, setMode);
    }
    if (canvas.current) return subscribeVideo(endpoint, token, canvas.current, setStatus);
  }, [endpoint, token, fallback, visible]);
  const live = visible && (fallback ? mode === "stream" || mode === "poll" : status === "Live video");
  const driven = control !== undefined;
  const controls = useViewerControls(endpoint, token, live && !fallback && (interactive || driven));
  const { setEnabled } = controls;
  useEffect(() => {
    if (driven) setEnabled(Boolean(control));
  }, [driven, control, setEnabled]);
  const blocked = !live || fallback || controls.busy;
  return (
    <div className={`dash-live${platform === "android" ? " is-android" : ""}`}>
      <div className={`dash-live-frame${live ? "" : " is-stale"}${controls.enabled ? " is-controlled" : ""}`}>
        {fallback ? (
          frame ? (
            <img src={frame} alt="Phone screenshot feed" />
          ) : (
            <div className="dash-live-wait">Waiting for the phone…</div>
          )
        ) : (
          <canvas ref={canvas} {...controls.pointerProps} style={{ touchAction: controls.enabled ? "none" : "auto", cursor: controls.enabled ? "crosshair" : "default" }} aria-label="Live phone video; enable controls to tap or drag" role="img" />
        )}
      </div>
      <div className="dash-live-note">
        <span className="dash-live-state" role="status">
          <i className={live ? "" : "is-stale"} aria-hidden />
          {fallback ? `${hasVideo ? "Screenshot mode" : "Live screen"} · ${mode === "stream" || mode === "poll" ? "updating" : mode}` : status}
        </span>
        {hasVideo && (
          <button type="button" className="dash-ghost is-sm" onClick={() => setFallback((value) => !value)}>
            {fallback ? "Use live video" : "Use screenshots"}
          </button>
        )}
      </div>
      {(interactive || (driven && controls.enabled)) && (
        <div className="phone-controls">
          {!driven && (
            <button type="button" className="dash-btn" aria-pressed={controls.enabled}
              onClick={() => controls.setEnabled(!controls.enabled)}>
              {controls.enabled ? "Disable controls" : "Enable controls"}
            </button>
          )}
          {controls.enabled && <>
            {!driven && <p>Tap the screen or drag and release to swipe. Your agent can still act.</p>}
            <div className="phone-control-buttons">
              <button type="button" className="dash-btn2" disabled={blocked} onClick={() => void controls.act("viewerInput", [{ button: "home" }])}>Home</button>
              <button type="button" className="dash-btn2" disabled={blocked} onClick={() => void controls.act("viewerInput", [{ button: "return" }])}>Return</button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); if (text) void controls.act("viewerInput", [{ text }]); }}>
              <input className="dash-input" aria-label="Text to paste on phone" value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} placeholder="Text to paste" />
              <button className="dash-btn2" disabled={blocked || !text} type="submit">Paste</button>
            </form>
            <p role="status">{controls.busy ? "Sending…" : controls.message}</p>
          </>}
        </div>
      )}
    </div>
  );
}
