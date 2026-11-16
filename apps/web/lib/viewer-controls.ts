"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { videoCoordinates, type Point } from "./simdeck/coordinates";

export function useViewerControls(endpoint: string, token: string, live: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const request = useRef<AbortController | null>(null);
  const gesture = useRef<{ id: number; start: Point; time: number; width: number; height: number } | null>(null);
  useEffect(() => () => { request.current?.abort(); gesture.current = null; }, [endpoint, token]);
  useEffect(() => { if (!live || !enabled) gesture.current = null; }, [live, enabled]);
  const act = async (method: string, args: unknown[] = []) => {
    if (!enabled || !live || pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    const abort = new AbortController();
    request.current = abort;
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, "")}/rpc`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ method, args }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? "Phone control failed");
      if (!abort.signal.aborted) setMessage("Done");
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Phone control failed");
    } finally {
      pending.current = false;
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!enabled || !live || pending.current || !event.isPrimary || event.button !== 0) return;
    const screen = event.currentTarget;
    const start = videoCoordinates(screen, event.clientX, event.clientY, screen.width, screen.height);
    if (!start) return;
    event.preventDefault();
    screen.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, start, time: performance.now(), width: screen.width, height: screen.height };
  };
  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    const screen = event.currentTarget;
    if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
    if (screen.width !== current.width || screen.height !== current.height) return;
    const end = videoCoordinates(screen, event.clientX, event.clientY, screen.width, screen.height);
    if (!end) return;
    const moved = Math.hypot((end.x-current.start.x)*screen.clientWidth, (end.y-current.start.y)*screen.clientHeight) > 6;
    void act("viewerInput", [{ start: current.start, ...(moved ? { end } : {}),
      width: current.width, height: current.height,
      durationMs: Math.min(2000, Math.max(50, Math.round(performance.now()-current.time))) }]);
  };
  return { enabled, setEnabled, busy, message, act, pointerProps: {
    onPointerDown: down, onPointerUp: up,
    onPointerCancel: () => { gesture.current = null; },
    onLostPointerCapture: () => { gesture.current = null; },
  } };
}
