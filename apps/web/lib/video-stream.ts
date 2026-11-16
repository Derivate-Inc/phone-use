/** Match the native helper's key/delta + timestamp + Annex-B access unit. */
export function readVideoPacket(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 14 || (bytes[0] !== 1 && bytes[0] !== 2)) throw new Error("Invalid video packet");
  const key = bytes[0] === 1;
  let codec: string | undefined;
  if (key) {
    for (let i = 9; i + 7 < bytes.length; i++) {
      if (
        bytes[i] === 0 &&
        bytes[i + 1] === 0 &&
        bytes[i + 2] === 0 &&
        bytes[i + 3] === 1 &&
        (bytes[i + 4]! & 31) === 7
      ) {
        codec = `avc1.${Array.from(bytes.subarray(i + 5, i + 8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
        break;
      }
    }
    if (!codec) throw new Error("Video keyframe has no H.264 configuration");
  }
  return { key, codec, timestamp: Number(new DataView(buffer).getBigUint64(1)), data: bytes.subarray(9) };
}

export function subscribeVideo(
  endpoint: string,
  token: string,
  canvas: HTMLCanvasElement,
  status: (message: string) => void,
): () => void {
  if (typeof VideoDecoder === "undefined") {
    status("Video decoding is unavailable in this browser. Try a current Chrome, Edge or Safari.");
    return () => {};
  }
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    status("Cannot create video display.");
    return () => {};
  }
  let stopped = false;
  let socket: WebSocket | undefined;
  let decoder: VideoDecoder | undefined;
  let retry: ReturnType<typeof setTimeout>;
  let watchdog: ReturnType<typeof setInterval>;
  let lastOutput = Date.now();
  let configured = false;
  let codec: string | undefined;
  let waitingForKey = true;
  const connect = () => {
    if (stopped) return;
    lastOutput = Date.now();
    configured = false;
    codec = undefined;
    waitingForKey = true;
    status("Connecting video…");
    const restart = () => {
      if (stopped || !socket) return;
      const old = socket;
      socket = undefined;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      old.close();
      clearInterval(watchdog);
      if (decoder?.state !== "closed") decoder?.close();
      status("Video interrupted · reconnecting…");
      retry = setTimeout(connect, 2000);
    };
    try {
      const ws = new WebSocket(
        `${endpoint.replace(/\/+$/, "").replace(/^http/, "ws")}/video?token=${encodeURIComponent(token)}`,
      );
      socket = ws;
      ws.binaryType = "arraybuffer";
      decoder = new VideoDecoder({
        output: (frame) => {
          try {
            if (stopped) return;
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
            }
            context.drawImage(frame, 0, 0);
            lastOutput = Date.now();
            status("Live video");
          } finally {
            frame.close();
          }
        },
        error: restart,
      });
      ws.onmessage = (event) => {
        if (stopped || socket !== ws || !(event.data instanceof ArrayBuffer)) return;
        try {
          const packet = readVideoPacket(event.data);
          if (!decoder || decoder.state === "closed") return;
          // Reset at overload and wait for a new IDR; P-frames depend on history.
          if (decoder.decodeQueueSize > 3) {
            decoder.reset();
            configured = false;
            waitingForKey = true;
          }
          if (waitingForKey && !packet.key) return;
          if (packet.key && (!configured || packet.codec !== codec)) {
            decoder.configure({ codec: packet.codec!, optimizeForLatency: true });
            configured = true;
            codec = packet.codec;
          }
          waitingForKey = false;
          decoder.decode(
            new EncodedVideoChunk({
              type: packet.key ? "key" : "delta",
              timestamp: packet.timestamp,
              data: packet.data,
            }),
          );
        } catch {
          restart();
        }
      };
      ws.onerror = restart;
      ws.onclose = restart;
      watchdog = setInterval(() => {
        if (Date.now() - lastOutput > 10000) restart();
      }, 1000);
    } catch {
      socket?.close();
      socket = undefined;
      if (decoder?.state !== "closed") decoder?.close();
      status("Cannot start video. Retrying…");
      retry = setTimeout(connect, 2000);
    }
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    socket?.close();
    if (decoder?.state !== "closed") decoder?.close();
  };
}
