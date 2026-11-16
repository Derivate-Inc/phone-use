"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A still of the phone's screen for the sidebar. It takes one frame from the
 * worker's /stream socket and closes it, rather than calling the screenshot
 * RPC: RPC calls land in the phone's action log, and a thumbnail must never
 * show up there as if the agent had acted.
 *
 * Opening /stream also counts as activity (the worker touches the phone so a
 * watched phone isn't reaped), so a frame is never taken on a timer. It is
 * taken when `refreshKey` changes, which the console derives from the agent's
 * latest action: the screen just changed, the phone was just used, and the
 * touch costs nothing. Pass undefined to leave the last frame as it is; an
 * idle phone is never kept alive by its thumbnail.
 */
export function useStreamThumb(
  connection: { endpoint: string; token: string } | undefined,
  refreshKey: number | undefined,
): string {
  const [src, setSrc] = useState("");
  const current = useRef("");
  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );
  const endpoint = connection?.endpoint;
  const token = connection?.token;
  useEffect(() => {
    if (!endpoint || !token || refreshKey === undefined) return;
    let done = false;
    let socket: WebSocket | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      done = true;
      clearTimeout(giveUp);
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.close();
      }
    };
    try {
      const ws = new WebSocket(`${endpoint.replace(/\/+$/, "").replace(/^http/, "ws")}/stream?token=${encodeURIComponent(token)}`);
      socket = ws;
      ws.binaryType = "blob";
      giveUp = setTimeout(finish, 8_000);
      ws.onmessage = (event) => {
        if (done || !(event.data instanceof Blob)) return;
        const next = URL.createObjectURL(event.data);
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = next;
        setSrc(next);
        finish();
      };
      ws.onerror = finish;
    } catch {
      finish();
    }
    return () => {
      if (!done) finish();
    };
  }, [endpoint, token, refreshKey]);
  return src;
}
