import { describe, expect, it } from 'vitest';
import { normalizedClientCoordinates, videoCoordinates } from '../lib/simdeck/coordinates';
const element = (width: number, height: number) => ({
  clientWidth: width, clientHeight: height,
  getBoundingClientRect: () => ({ left: 10, top: 20, width, height }),
}) as unknown as HTMLElement;
describe('SimDeck coordinate adaptation', () => {
  it('excludes letterboxing and maps the content center correctly', () => {
    const box = element(400, 400);
    expect(videoCoordinates(box, 210, 220, 200, 400)).toEqual({ x: .5, y: .5 });
    expect(videoCoordinates(box, 20, 220, 200, 400)).toBeNull();
    expect(videoCoordinates(box, 210, 220, 0, 400)).toBeNull();
  });
  it('handles transformed boxes and rejects degenerate transforms', () => {
    const box = { ...element(400, 400), getBoxQuads: () => [{
      p1: { x: 100, y: 100 }, p2: { x: 100, y: 500 }, p4: { x: -300, y: 100 },
    }] } as unknown as HTMLElement;
    expect(normalizedClientCoordinates(box, -100, 300)).toEqual({ x: .5, y: .5 });
    const zero = { getBoxQuads: () => [{ p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, p4: { x: 0, y: 0 } }] } as unknown as HTMLElement;
    expect(normalizedClientCoordinates(zero, 0, 0)).toBeNull();
  });
});
