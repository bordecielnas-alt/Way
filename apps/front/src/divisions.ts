// Regions inside a territory (duchies, provinces, counties). The historical
// maps only draw states: their inner divisions are approximated from the
// seats Wikidata gives, by sharing the territory between them (each place
// goes to its nearest seat, a Voronoi diagram clipped to the territory).

export type Ring = [number, number][];

export interface Area {
  rings: Ring[];
  west: number; south: number; east: number; north: number;
}

export interface Seat { qid: string; label: string; kind: string | null; lat: number; lon: number }

export interface Region extends Area, Seat {}

export function bounds(rings: Ring[]): Area {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  return { rings, west, south, east, north };
}

/** Even-odd point in polygon over all rings (holes included). */
export function contains(a: Area, lon: number, lat: number): boolean {
  if (lon < a.west || lon > a.east || lat < a.south || lat > a.north) return false;
  let inside = false;
  for (const ring of a.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Keeps the part of a convex polygon where (p - m) · n <= 0. */
function halfPlane(poly: Ring, mx: number, my: number, nx: number, ny: number): Ring {
  const out: Ring = [];
  const side = (p: [number, number]) => (p[0] - mx) * nx + (p[1] - my) * ny;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Voronoi cells of `sites` inside a box, as counter-clockwise convex
 * polygons. Plain half-plane intersection: O(n²), fine for ~100 seats.
 */
export function voronoi(sites: [number, number][], box: [number, number, number, number]): Ring[] {
  const [x0, y0, x1, y1] = box;
  return sites.map(([sx, sy], i) => {
    let cell: Ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let j = 0; j < sites.length && cell.length > 0; j++) {
      if (j === i) continue;
      const [tx, ty] = sites[j]!;
      cell = halfPlane(cell, (sx + tx) / 2, (sy + ty) / 2, tx - sx, ty - sy);
    }
    return cell;
  });
}

/**
 * Sutherland-Hodgman: the part of any ring inside a convex counter-clockwise
 * polygon. A concave ring may come out with zero-width bridges along the
 * clip edges; they fall on the cell border, where a line is drawn anyway.
 */
export function clipRing(ring: Ring, convex: Ring): Ring {
  let out = ring;
  for (let i = 0; i < convex.length && out.length > 0; i++) {
    const a = convex[i]!;
    const b = convex[(i + 1) % convex.length]!;
    // Inside is on the left of a->b: the half-plane whose outward normal points right.
    out = halfPlane(out, a[0], a[1], b[1] - a[1], a[0] - b[0]);
  }
  return out;
}

/**
 * Shares a territory between the seats found inside it. Seats outside the
 * territory (the list comes from Wikidata links, the shape from another
 * dataset) are left out; two seats at the same spot keep the better known.
 */
export function divide(parent: Area, seats: Seat[]): Region[] {
  const kept: Seat[] = [];
  for (const s of seats) {
    if (!contains(parent, s.lon, s.lat)) continue;
    if (kept.some((k) => Math.abs(k.lon - s.lon) < 0.02 && Math.abs(k.lat - s.lat) < 0.02)) continue;
    kept.push(s);
  }
  if (kept.length < 2) return [];
  // Degrees of longitude shrink with latitude: measure distances on a locally scaled plane.
  const k = Math.cos((((parent.south + parent.north) / 2) * Math.PI) / 180) || 1;
  const cells = voronoi(
    kept.map((s) => [s.lon * k, s.lat]),
    [(parent.west - 1) * k, parent.south - 1, (parent.east + 1) * k, parent.north + 1],
  );
  const regions: Region[] = [];
  kept.forEach((s, i) => {
    const cell = cells[i]!.map(([x, y]) => [x / k, y] as [number, number]);
    const rings = parent.rings.map((r) => clipRing(r, cell)).filter((r) => r.length >= 3);
    if (rings.length) regions.push({ ...s, ...bounds(rings) });
  });
  return regions;
}
