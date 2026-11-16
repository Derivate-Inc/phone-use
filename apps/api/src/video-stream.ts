import { fileURLToPath } from 'node:url';

/** Helper stdout: uint32 BE length, then key/delta byte, uint64 BE µs, Annex-B. */
export class VideoPackets {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const packets: Buffer[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32BE(0);
      if (size < 14 || size > 8_000_000) throw new Error('Invalid video packet size');
      if (this.pending.length < size + 4) break;
      packets.push(Buffer.from(this.pending.subarray(4, size + 4)));
      this.pending = this.pending.subarray(size + 4);
    }
    return packets;
  }
}
export type VideoSocket = {
  data: { deviceId: string; sandboxId: string };
  readyState: number;
  send: (data: ArrayBuffer | Uint8Array) => unknown;
  close: () => void;
  getBufferedAmount?: () => number;
};
type CaptureProcess = { stdout: ReadableStream<Uint8Array>; kill: () => void };

function startCapture(id: string): CaptureProcess {
  const binary =
    process.env.PHONE_USE_VIDEO_BIN ?? fileURLToPath(new URL('../native/phone-video', import.meta.url));
  return Bun.spawn([binary, id], { stdout: 'pipe', stderr: 'inherit' });
}

type Hub = { sockets: Map<VideoSocket, boolean>; stop: () => void };

export class VideoStreams {
  private hubs = new Map<string, Hub>();
  constructor(
    private readonly touch: (id: string) => Promise<unknown>,
    private readonly capture = startCapture,
  ) {}

  open(ws: VideoSocket): void {
    const id = ws.data.deviceId;
    const existing = this.hubs.get(id);
    if (existing) {
      existing.sockets.set(ws, false);
      return;
    }
    const sockets = new Map<VideoSocket, boolean>([[ws, false]]);
    let proc: CaptureProcess | undefined;
    let lastPacket = Date.now();
    let lastTouch = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - lastPacket > 10000) {
        hub.stop();
        return;
      }
      if (Date.now() - lastTouch > 30000) {
        lastTouch = Date.now();
        void this.touch(ws.data.sandboxId).catch(() => hub.stop());
      }
    }, 1000);
    const hub: Hub = {
      sockets,
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        proc?.kill();
        if (this.hubs.get(id) === hub) this.hubs.delete(id);
        for (const client of sockets.keys()) client.close();
        sockets.clear();
      },
    };
    this.hubs.set(id, hub);
    void (async () => {
      try {
        proc = this.capture(id);
        const parser = new VideoPackets();
        for await (const bytes of proc.stdout as ReadableStream<Uint8Array>) {
          if (stopped) break;
          for (const packet of parser.push(bytes)) {
            lastPacket = Date.now();
            for (const [client, synced] of sockets) {
              if (client.readyState !== 1) continue;
              // TCP already holds dependent frames: disconnect slow consumers,
              // never drop arbitrary P-frames and continue a corrupt GOP.
              if ((client.getBufferedAmount?.() ?? 0) > 1_000_000) {
                sockets.delete(client);
                client.close();
                continue;
              }
              if (!synced && packet[0] !== 1) continue;
              sockets.set(client, true);
              client.send(packet);
            }
            if (sockets.size === 0) hub.stop();
          }
        }
      } catch (error) {
        console.error('video stream unavailable:', error instanceof Error ? error.message : String(error));
      } finally {
        hub.stop();
      }
    })();
  }
  close(ws: VideoSocket): void {
    const hub = this.hubs.get(ws.data.deviceId);
    hub?.sockets.delete(ws);
    if (hub?.sockets.size === 0) hub.stop();
  }
  stopDevice(id: string): void {
    this.hubs.get(id)?.stop();
  }
  stop(): void {
    for (const hub of this.hubs.values()) hub.stop();
  }
}
