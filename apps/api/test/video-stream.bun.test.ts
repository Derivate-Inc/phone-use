import { describe, expect, it } from 'bun:test';
import { VideoPackets, VideoStreams, type VideoSocket } from '../src/video-stream.ts';

function packet(key: boolean) {
  const body = Buffer.alloc(20);
  body[0] = key ? 1 : 2;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}
describe('video transport', () => {
  it('reassembles split headers and multiple access units without losing boundaries', () => {
    const parser = new VideoPackets();
    const input = Buffer.concat([packet(true), packet(false)]);
    expect(parser.push(input.subarray(0, 2))).toEqual([]);
    expect(parser.push(input.subarray(2, 15))).toEqual([]);
    const frames = parser.push(input.subarray(15));
    expect(frames.map((frame) => frame[0])).toEqual([1, 2]);
    expect(parser.push(new Uint8Array())).toEqual([]);
  });
  it('rejects corrupt lengths before accumulating unlimited data', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(9_000_000);
    expect(() => new VideoPackets().push(header)).toThrow('Invalid video');
  });
  it('shares capture, gates late viewers on IDR, disconnects slow viewers, stops on last close', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let starts = 0,
      kills = 0;
    const streams = new VideoStreams(
      async () => {},
      () => {
        starts++;
        return {
          stdout: new ReadableStream({
            start(c) {
              controller = c;
            },
          }),
          kill() {
            kills++;
            controller.close();
          },
        };
      },
    );
    const frames: number[][] = [[], []];
    const closed = [0, 0];
    let backlog = 0;
    const clients = frames.map(
      (output, i): VideoSocket => ({
        data: { deviceId: 'sim', sandboxId: 'sandbox' },
        readyState: 1,
        send(data) {
          output.push(new Uint8Array(data as Uint8Array)[0]!);
        },
        close() {
          closed[i] = (closed[i] ?? 0) + 1;
        },
        getBufferedAmount() {
          return i === 1 ? backlog : 0;
        },
      }),
    );
    const emit = async (key: boolean) => {
      controller.enqueue(packet(key));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    try {
      streams.open(clients[0]!);
      await emit(true);
      streams.open(clients[1]!);
      await emit(false);
      expect(frames).toEqual([[1, 2], []]);
      await emit(true);
      expect(frames).toEqual([[1, 2, 1], [1]]);
      backlog = 1_000_001;
      await emit(false);
      expect(closed[1]).toBe(1);
      expect(starts).toBe(1);
      streams.close(clients[0]!);
      expect(kills).toBe(1);
    } finally {
      streams.stop();
    }
  });
});
