// Adapted from NativeScript/SimDeck at 2d7346b (MIT). See LICENSE.simdeck.
// Kept transformed-box mapping; added object-fit:contain coordinate handling.
export type Point = { x: number; y: number };
type QuadPoint = { x: number; y: number };
type BoxQuad = {
  p1: QuadPoint;
  p2: QuadPoint;
  p4: QuadPoint;
};
type ElementWithBoxQuads = HTMLElement & {
  getBoxQuads?: () => BoxQuad[];
};

function clampNormalized(point: Point): Point {
  return {
    x: Math.min(Math.max(point.x, 0), 1),
    y: Math.min(Math.max(point.y, 0), 1),
  };
}

function pointInTransformedBox(point: QuadPoint, quad: BoxQuad): Point | null {
  const xAxis = {
    x: quad.p2.x - quad.p1.x,
    y: quad.p2.y - quad.p1.y,
  };
  const yAxis = {
    x: quad.p4.x - quad.p1.x,
    y: quad.p4.y - quad.p1.y,
  };
  const relative = {
    x: point.x - quad.p1.x,
    y: point.y - quad.p1.y,
  };
  const determinant = xAxis.x * yAxis.y - xAxis.y * yAxis.x;
  if (Math.abs(determinant) < 0.000001) {
    return null;
  }

  return {
    x: (relative.x * yAxis.y - relative.y * yAxis.x) / determinant,
    y: (xAxis.x * relative.y - xAxis.y * relative.x) / determinant,
  };
}

export function normalizedClientCoordinates(
  target: HTMLElement,
  clientX: number,
  clientY: number,
  { clamp = true }: { clamp?: boolean } = {},
): Point | null {
  const quad = (() => {
    try {
      return (target as ElementWithBoxQuads).getBoxQuads?.()[0] ?? null;
    } catch {
      return null;
    }
  })();
  if (quad) {
    const point = pointInTransformedBox({ x: clientX, y: clientY }, quad);
    return point ? (clamp ? clampNormalized(point) : point) : null;
  }

  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const point = {
    x: (clientX - rect.left) / rect.width,
    y: (clientY - rect.top) / rect.height,
  };
  return clamp ? clampNormalized(point) : point;
}


/** Map the displayed video content, excluding object-fit:contain letterboxing. */
export function videoCoordinates(target: HTMLElement, clientX: number, clientY: number,
  width: number, height: number): Point | null {
  if (!(width > 0 && height > 0)) return null;
  const point = normalizedClientCoordinates(target, clientX, clientY, { clamp: false });
  if (!point || !target.clientWidth || !target.clientHeight) return null;
  const scale = Math.min(target.clientWidth / width, target.clientHeight / height);
  const x = (point.x * target.clientWidth - (target.clientWidth - width * scale) / 2) / (width * scale);
  const y = (point.y * target.clientHeight - (target.clientHeight - height * scale) / 2) / (height * scale);
  return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
}
