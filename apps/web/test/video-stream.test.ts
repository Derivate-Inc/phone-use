import { describe, expect, it } from "vitest";
import { readVideoPacket } from "../lib/video-stream";

describe("browser H.264 protocol", () => {
  it("reads timestamps and derives the actual codec from SPS rather than hardcoding a level", () => {
    const bytes = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x33]);
    new DataView(bytes.buffer).setBigUint64(1, BigInt(1234567));
    const packet = readVideoPacket(bytes.buffer);
    expect(packet.codec).toBe("avc1.42c033");
    expect(packet.timestamp).toBe(1234567);
    expect(packet.key).toBe(true);
    expect(packet.data[4]).toBe(0x67);
  });
  it("rejects invalid packets and keyframes without configuration", () => {
    expect(() => readVideoPacket(new ArrayBuffer(5))).toThrow();
    const bytes = new Uint8Array(20);
    bytes[0] = 1;
    expect(() => readVideoPacket(bytes.buffer)).toThrow("configuration");
    bytes[0] = 2;
    expect(readVideoPacket(bytes.buffer).key).toBe(false);
  });
});
