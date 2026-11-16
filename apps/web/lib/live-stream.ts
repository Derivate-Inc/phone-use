export type StreamMode = "connecting" | "stream" | "poll" | "stale";

/** One subscription per viewer. A silent socket is unhealthy even if still open. */
export function subscribeLiveStream(
  endpoint: string,
  token: string,
  onFrame: (url: string) => void,
  onMode: (mode: StreamMode) => void,
): () => void {
  let stopped = false;
  let socket: WebSocket | undefined;
  let lastFrame = 0;
  let blobUrl = "";
  let polling = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const base = endpoint.replace(/\/+$/, "");
  const show = (url: string, mode: StreamMode) => {
    const previous = blobUrl;
    blobUrl = url.startsWith("blob:") ? url : "";
    onFrame(url);
    onMode(mode);
    if (previous) URL.revokeObjectURL(previous);
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const response = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ method: "screenshot", args: [{}] }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
      });
      const body = (await response.json()) as { ok?: boolean; result?: { base64?: string } };
      if (!stopped && Date.now() - lastFrame >= 5000) {
        if (response.ok && body.ok && body.result?.base64) {
          show(`data:image/png;base64,${body.result.base64}`, "poll");
        } else onMode("stale");
      }
    } catch {
      if (!stopped && Date.now() - lastFrame >= 5000) onMode("stale");
    } finally {
      polling = false;
      if (!stopped && Date.now() - lastFrame >= 5000) pollTimer = setTimeout(poll, 1200);
    }
  };
  const connect = () => {
    if (stopped) return;
    const started = Date.now();
    try {
      const ws = new WebSocket(`${base.replace(/^http/, "ws")}/stream?token=${encodeURIComponent(token)}`);
      socket = ws;
      ws.binaryType = "blob";
      ws.onmessage = (event) => {
        if (stopped || socket !== ws || !(event.data instanceof Blob)) return;
        lastFrame = Date.now();
        clearTimeout(pollTimer);
        show(URL.createObjectURL(event.data), "stream");
      };
      const fallback = () => {
        if (stopped || socket !== ws) return;
        socket = undefined;
        clearInterval(watchdog);
        ws.onclose = null;
        ws.close();
        onMode("stale");
        clearTimeout(pollTimer);
        void poll();
        retry = setTimeout(connect, 5000);
      };
      ws.onerror = fallback;
      ws.onclose = fallback;
      // Store the connection's age separately from the last delivered frame.
      watchdog = setInterval(() => {
        if (Date.now() - Math.max(started, lastFrame) >= 5000) {
          clearInterval(watchdog);
          fallback();
        }
      }, 1000);
    } catch {
      onMode("stale");
      void poll();
      retry = setTimeout(connect, 5000);
    }
  };
  let watchdog: ReturnType<typeof setInterval> | undefined;
  onMode("connecting");
  connect();
  return () => {
    stopped = true;
    abort.abort();
    clearInterval(watchdog);
    clearTimeout(retry);
    clearTimeout(pollTimer);
    socket?.close();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  };
}
