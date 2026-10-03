import {
  Cartesian2, Cartesian3, Color, DistanceDisplayCondition, LabelCollection, LabelStyle, Material, NearFarScalar,
  PointPrimitiveCollection, PolylineCollection, VerticalOrigin,
  type Label, type PointPrimitive, type Polyline, type Viewer,
} from 'cesium';
import {
  cityAt, FLOWS, flowsIn, flowView, histToAstro, type CityRow, type Flow, type FlowDef, type FlowKind, type FlowsResponse,
  type FlowStatus,
} from '@way/shared';
import { setActivity } from './activity.ts';
import { findRoute, pointOn, withEffort, WaterGrid, type Pt, type Route } from './routes.ts';

// Monde vivant: cities that swell and shrink with the timeline, and flows
// (trade routes, epidemics, diffusions) whose places light up as they are
// reached, the way between them drawn as it is travelled. Caravans and
// ships go along the trade routes while they are alive.

export interface Living { cities: boolean; trade: boolean; epidemic: boolean; diffusion: boolean }
export const NO_LIVING: Living = { cities: false, trade: false, epidemic: false, diffusion: false };

/** Toggles of the Monde vivant section, with their color on the map (the legend). */
export const LIVING: { key: keyof Living; label: string; title: string; color: string }[] = [
  { key: 'cities', label: 'Villes', title: 'Les grandes villes grandissent et déclinent (population estimée, Chandler et Modelski)', color: '#efe4cc' },
  { key: 'trade', label: 'Commerce', title: 'Grandes routes commerciales, caravanes et navires en chemin', color: '#d9a441' },
  { key: 'epidemic', label: 'Épidémies', title: 'Les grandes épidémies se propagent, ville après ville', color: '#d9534f' },
  { key: 'diffusion', label: 'Diffusions', title: 'Religions, écritures et techniques qui se répandent', color: '#7fb3e0' },
];

const CITY_COLOR = Color.fromCssColorString('#efe4cc');
const EDGE_COLORS: Record<FlowKind, string> = { trade: '#d9a441', epidemic: '#d9534f', diffusion: '#7fb3e0' };
/** Diffusions are told apart by their own color. */
const DIFFUSION_COLORS = ['#7fb3e0', '#b18be0', '#8fbf5a', '#4fb3c4', '#e0864a', '#d673b1', '#c9c0ad'];
const CARAVAN = Color.fromCssColorString('#ffc53d');
const SHIP = Color.fromCssColorString('#9fd0ff');
/** City names written on the map, the largest of the moment. */
const CITY_LABELS = 24;
/** A caravan takes this long along a way (ms), whatever its length. */
const TRIP_MS = 9000;
const MOVERS_PER_WAY = 2;
const FRAME_MS = 33;
/** Time spent finding realistic ways per frame (ms). */
const ROUTE_BUDGET_MS = 8;

export type LivingPick =
  | { kind: 'city'; city: CityRow; pop: number; sure: number }
  | { kind: 'flow'; def: FlowDef; flow: Flow; stage: number };

/** Number of inhabitants, rounded as the estimates deserve: "≈ 450 000". */
export function formatPop(n: number): string {
  const digits = n >= 1_000_000 ? 100_000 : n >= 100_000 ? 10_000 : n >= 10_000 ? 1000 : 100;
  return `≈ ${(Math.round(n / digits) * digits).toLocaleString('fr-FR')}`;
}

/** Point size of a city: 5 000 people is a dot, 10 million a disc. */
export function citySize(pop: number): number {
  return 3 + 2.6 * Math.log10(Math.max(1, pop / 5000));
}

function greatCircle(a: Pt, b: Pt, n: number): Pt[] {
  const r = Math.PI / 180;
  const v = ([lat, lon]: Pt) => [Math.cos(lat * r) * Math.cos(lon * r), Math.cos(lat * r) * Math.sin(lon * r), Math.sin(lat * r)] as const;
  const va = v(a), vb = v(b);
  const w = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
  if (w < 1e-9) return [a, b];
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const sa = Math.sin((1 - f) * w) / Math.sin(w);
    const sb = Math.sin(f * w) / Math.sin(w);
    const x = sa * va[0] + sb * vb[0], y = sa * va[1] + sb * vb[1], z = sa * va[2] + sb * vb[2];
    out.push([Math.atan2(z, Math.hypot(x, y)) / r, Math.atan2(y, x) / r]);
  }
  return out;
}

/** The straight (great circle) way, as a route: until a realistic one is found, and for spreads. */
function arc(a: Pt, b: Pt): Route {
  const pts = greatCircle(a, b, 24);
  return withEffort(pts, pts.map(() => false));
}

const toCartesian = (pts: Pt[]) => pts.map(([lat, lon]) => Cartesian3.fromDegrees(lon, lat, 200));

interface Way { from: number; to: number; route: Route; line: Polyline; exact: boolean }
interface Drawn {
  def: FlowDef;
  flow: Flow;
  color: Color;
  points: PointPrimitive[];
  ways: Way[];
}

function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class LivingLayer {
  private on: Living = NO_LIVING;
  private year = 0;
  private window = { tStart: 0, tEnd: 0 };

  private cities: CityRow[] | null = null;
  private citiesLoading = false;
  private cityPoints: PointPrimitiveCollection;
  private cityDots: PointPrimitive[] = [];
  private labels: LabelCollection;
  private cityLabels: Label[] = [];

  private flowPoints: PointPrimitiveCollection;
  private lines: PolylineCollection;
  private movers: PointPrimitiveCollection;
  private moverPool: PointPrimitive[] = [];
  private known = new Map<string, { status: FlowStatus; flow: Flow | null }>();
  private drawn = new Map<string, Drawn>();
  private asking = false;
  private pollTimer: number | undefined;
  private grid: WaterGrid | null = null;
  private gridLoading = false;
  private routeQueue: Way[] = [];
  private frame = 0;
  private lastFrame = 0;
  /** Places just reached: they pulse. */
  private hot: { p: PointPrimitive; base: number; h: number }[] = [];

  /** What the layer is doing, in a few words (shown under its toggles), or '' when all is well. */
  onStatus: (text: string) => void = () => undefined;

  constructor(private viewer: Viewer) {
    const scene = viewer.scene;
    this.lines = scene.primitives.add(new PolylineCollection());
    this.cityPoints = scene.primitives.add(new PointPrimitiveCollection());
    this.flowPoints = scene.primitives.add(new PointPrimitiveCollection());
    this.movers = scene.primitives.add(new PointPrimitiveCollection());
    this.labels = scene.primitives.add(new LabelCollection({ scene }));
  }

  set(l: Living): void {
    this.on = l;
    if (l.cities) void this.loadCities();
    if (l.trade) void this.loadGrid();
    this.cityPoints.show = l.cities;
    this.labels.show = l.cities;
    void this.askFlows();
    this.update();
  }

  /** The period shown (which flows to ask for) and the moment (decimal years: what is drawn). */
  setWindow(tStart: number, tEnd: number, moment: number): void {
    const moved = tStart !== this.window.tStart || tEnd !== this.window.tEnd;
    this.window = { tStart, tEnd };
    this.year = moment;
    if (moved) void this.askFlows();
    this.update();
  }

  private kinds(): FlowKind[] {
    return (['trade', 'epidemic', 'diffusion'] as const).filter((k) => this.on[k]);
  }

  // ---------- data ----------

  private async loadCities(): Promise<void> {
    if (this.cities || this.citiesLoading) return;
    this.citiesLoading = true;
    try {
      const r = await fetch('/geo/cities.json');
      if (!r.ok) throw new Error(String(r.status));
      this.cities = ((await r.json()) as { cities: CityRow[] }).cities;
      this.cityDots = this.cities.map((c, i) =>
        this.cityPoints.add({
          position: Cartesian3.fromDegrees(c[3], c[2], 300),
          show: false,
          color: CITY_COLOR,
          outlineColor: Color.fromCssColorString('#3a2a10').withAlpha(0.8),
          outlineWidth: 1,
          scaleByDistance: new NearFarScalar(1.5e6, 1.25, 2e7, 0.65),
          id: { living: i },
        }),
      );
      for (let i = 0; i < CITY_LABELS; i++) {
        this.cityLabels.push(this.labels.add({
          position: Cartesian3.ZERO,
          show: false,
          text: '',
          font: '500 12px "Inter Variable", system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#f3e3bf'),
          outlineColor: Color.fromCssColorString('#1a140a'),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.TOP,
          pixelOffset: new Cartesian2(0, 8),
          scaleByDistance: new NearFarScalar(1.5e6, 1, 2e7, 0.75),
          distanceDisplayCondition: new DistanceDisplayCondition(0, 2.6e7),
        }));
      }
      this.update();
    } catch {
      this.onStatus('Données des villes introuvables.');
    } finally {
      this.citiesLoading = false;
    }
  }

  private async loadGrid(): Promise<void> {
    if (this.grid || this.gridLoading) return;
    this.gridLoading = true;
    try {
      const r = await fetch('/geo/water.bin');
      if (r.ok) {
        this.grid = WaterGrid.decode(await r.arrayBuffer());
        for (const d of this.drawn.values()) if (d.def.kind === 'trade') this.routeQueue.push(...d.ways.filter((w) => !w.exact));
        this.animate();
      }
    } catch {
      /* straight ways */
    } finally {
      this.gridLoading = false;
    }
  }

  /** Asks for the flows of the period not known yet; again while some are being read. */
  private async askFlows(): Promise<void> {
    clearTimeout(this.pollTimer);
    const kinds = this.kinds();
    const defs = kinds.length ? flowsIn(this.window.tStart, this.window.tEnd, kinds) : [];
    const ask = defs.filter((d) => this.known.get(d.id)?.status !== 'ready' && this.known.get(d.id)?.status !== 'empty');
    if (ask.length && !this.asking) {
      this.asking = true;
      try {
        const r = await fetch(`/api/flows?${new URLSearchParams({ ids: ask.map((d) => d.id).join(',') })}`);
        if (r.ok) for (const f of ((await r.json()) as FlowsResponse).flows) this.known.set(f.id, { status: f.status, flow: f.flow });
      } catch {
        /* asked again at the next change */
      } finally {
        this.asking = false;
      }
    }
    const status = defs.map((d) => this.known.get(d.id)?.status);
    const pending = status.filter((s) => s === 'pending').length;
    const noAi = status.filter((s) => s === 'no-ai').length;
    this.onStatus(
      pending ? `L’IA lit ${pending > 1 ? `${pending} articles` : 'un article'} de Wikipédia pour tracer ${pending > 1 ? 'ces flux' : 'ce flux'}…`
        : noAi ? `${noAi > 1 ? `${noAi} flux` : 'Un flux'} de cette période ${noAi > 1 ? 'attendent' : 'attend'} une IA pour être lu${noAi > 1 ? 's' : ''} (Réglages → clés).`
          : '',
    );
    setActivity('flows', pending ? { label: 'IA · monde vivant', title: 'L’IA lit Wikipédia pour tracer les flux de la période', ai: true } : null);
    if (pending) this.pollTimer = window.setTimeout(() => void this.askFlows(), 6000);
    this.update();
  }

  // ---------- drawing ----------

  private drawnOf(def: FlowDef, flow: Flow): Drawn {
    let d = this.drawn.get(def.id);
    if (d) return d;
    const css = def.kind === 'diffusion' ? DIFFUSION_COLORS[hashOf(def.id) % DIFFUSION_COLORS.length]! : EDGE_COLORS[def.kind];
    const color = Color.fromCssColorString(css);
    const points = flow.stages.map((s, i) =>
      this.flowPoints.add({
        position: Cartesian3.fromDegrees(s.lon, s.lat, 400),
        show: false,
        color,
        outlineColor: Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        scaleByDistance: new NearFarScalar(1.5e6, 1.2, 2e7, 0.7),
        id: { living: `${def.id}:${i}` },
      }),
    );
    const ways = flow.stages.flatMap((s, i): Way[] => {
      if (s.from === null) return [];
      const a = flow.stages[s.from]!;
      const route = arc([a.lat, a.lon], [s.lat, s.lon]);
      const material = def.kind === 'trade'
        ? Material.fromType('PolylineDash', { color: color.withAlpha(0.85), dashLength: 16 })
        // Spreads go one way: an arrow, its head on the front of the wave.
        : Material.fromType('PolylineArrow', { color: color.withAlpha(0.85) });
      const line = this.lines.add({ positions: toCartesian(route.pts), width: def.kind === 'trade' ? 2.5 : 7, material, show: false });
      return [{ from: s.from, to: i, route, line, exact: false }];
    });
    d = { def, flow, color, points, ways };
    this.drawn.set(def.id, d);
    if (def.kind === 'trade') this.routeQueue.push(...ways);
    return d;
  }

  /** Redraws everything for the moment shown. */
  private update(): void {
    this.updateCities();
    this.updateFlows();
    this.viewer.scene.requestRender();
    this.animate();
  }

  private updateCities(): void {
    if (!this.cities || !this.on.cities) return;
    const shown: { i: number; pop: number }[] = [];
    this.cities.forEach((c, i) => {
      const at = cityAt(c[5], this.year);
      const dot = this.cityDots[i]!;
      dot.show = !!at;
      if (!at) return;
      dot.pixelSize = citySize(at.pop);
      dot.color = CITY_COLOR.withAlpha(0.45 + 0.45 * at.sure);
      shown.push({ i, pop: at.pop });
    });
    shown.sort((a, b) => b.pop - a.pop);
    this.cityLabels.forEach((l, k) => {
      const s = shown[k];
      l.show = !!s;
      if (!s) return;
      const c = this.cities![s.i]!;
      l.text = c[0];
      l.position = Cartesian3.fromDegrees(c[3], c[2], 300);
    });
  }

  private updateFlows(): void {
    const kinds = new Set(this.kinds());
    const t = histToAstro(Math.floor(this.year)) + (this.year - Math.floor(this.year));
    const alive = new Set<string>();
    const hot: typeof this.hot = [];
    for (const def of FLOWS) {
      const k = this.known.get(def.id);
      if (!kinds.has(def.kind) || !k?.flow) continue;
      const view = flowView(def, k.flow, this.year);
      const d = view.stages.length ? this.drawnOf(def, k.flow) : this.drawn.get(def.id);
      if (!d) continue;
      alive.add(def.id);
      const heat = new Map(view.stages.map((s) => [s.i, s.hot]));
      d.points.forEach((p, i) => {
        const h = heat.get(i);
        p.show = h !== undefined;
        if (h === undefined) return;
        p.pixelSize = 6 + 7 * h;
        if (h > 0 && def.kind !== 'trade') hot.push({ p, base: p.pixelSize, h });
        p.color = d.color.withAlpha(def.kind === 'epidemic' ? 0.35 + 0.65 * h : 0.6 + 0.4 * h);
      });
      if (!view.stages.length) {
        for (const w of d.ways) w.line.show = false;
        continue;
      }
      // A way is drawn as it is travelled: from the date its start was reached to the date of its end.
      const yearOf = (i: number) => histToAstro(Math.max(def.start, d.flow.stages[i]!.year));
      for (const w of d.ways) {
        const y0 = yearOf(w.from);
        const y1 = yearOf(w.to);
        const f = !heat.has(w.from) ? 0 : heat.has(w.to) || y1 <= y0 ? 1 : Math.min(1, Math.max(0, (t - y0) / (y1 - y0)));
        w.line.show = f > 0;
        if (f > 0 && f < 1) w.line.positions = toCartesian(pointOn(w.route, f).passed);
        else if (f === 1) w.line.positions = toCartesian(w.route.pts);
      }
    }
    // Flows out of the period or turned off.
    for (const [id, d] of this.drawn) {
      if (alive.has(id)) continue;
      for (const p of d.points) p.show = false;
      for (const w of d.ways) w.line.show = false;
    }
    this.hot = hot;
  }

  /** Ways of the living trade routes, fully drawn: caravans and ships go along them. */
  private tradeWays(): Way[] {
    if (!this.on.trade) return [];
    const out: Way[] = [];
    for (const d of this.drawn.values()) {
      if (d.def.kind !== 'trade') continue;
      const t = histToAstro(Math.floor(this.year));
      if (t < histToAstro(d.def.start) || t > histToAstro(d.def.end)) continue;
      for (const w of d.ways) if (w.line.show && d.points[w.to]!.show) out.push(w);
    }
    return out;
  }

  /** Caravans, ships and the pulse of hot places move on their own, a frame at a time, while there are some. */
  private animate(): void {
    if (this.frame) return;
    const step = (now: number) => {
      this.frame = 0;
      const ways = this.tradeWays();
      const routing = this.routeQueue.length > 0 && !!this.grid;
      if (!ways.length && !this.hot.length && !routing) {
        this.moverPool.forEach((m) => (m.show = false));
        this.viewer.scene.requestRender();
        return;
      }
      this.frame = requestAnimationFrame(step);
      if (now - this.lastFrame < FRAME_MS) return;
      this.lastFrame = now;
      if (routing) this.findRoutes();
      this.moveCaravans(ways, now);
      if (this.hot.length) this.pulse(now);
      this.viewer.scene.requestRender();
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Realistic ways for trade (round the seas, by ship where it must), a few per frame. */
  private findRoutes(): void {
    const until = performance.now() + ROUTE_BUDGET_MS;
    while (this.routeQueue.length && performance.now() < until) {
      const w = this.routeQueue.shift()!;
      if (w.exact) continue;
      const a = w.route.pts[0]!;
      const b = w.route.pts[w.route.pts.length - 1]!;
      const found = findRoute(this.grid!, a, b);
      w.exact = true;
      if (!found) continue;
      w.route = found;
      this.updateFlows();
    }
  }

  private moveCaravans(ways: Way[], now: number): void {
    const want = ways.length * MOVERS_PER_WAY;
    while (this.moverPool.length < want) {
      this.moverPool.push(this.movers.add({ pixelSize: 7, color: CARAVAN, outlineColor: Color.fromCssColorString('#2a1a05'), outlineWidth: 2, show: false }));
    }
    this.moverPool.forEach((m, k) => {
      const w = ways[Math.floor(k / MOVERS_PER_WAY)];
      m.show = !!w;
      if (!w) return;
      const phase = ((now / TRIP_MS + (k % MOVERS_PER_WAY) / MOVERS_PER_WAY + (w.to * 0.37) % 1) % 1);
      // Out and back: goods travel both ways.
      const f = k % 2 ? phase : 1 - phase;
      const at = pointOn(w.route, f);
      m.position = Cartesian3.fromDegrees(at.p[1], at.p[0], 600);
      m.color = at.water ? SHIP : CARAVAN;
    });
  }

  private pulse(now: number): void {
    const s = Math.sin(now / 260);
    for (const { p, base, h } of this.hot) p.pixelSize = base * (1 + 0.3 * h * s);
  }

  // ---------- picking ----------

  pick(position: Cartesian2): LivingPick | null {
    const hit = this.viewer.scene.pick(position) as { id?: { living?: number | string } } | undefined;
    const id = hit?.id?.living;
    if (id === undefined) return null;
    if (typeof id === 'number') {
      const city = this.cities?.[id];
      const at = city && cityAt(city[5], this.year);
      return city && at ? { kind: 'city', city, pop: at.pop, sure: at.sure } : null;
    }
    const [flowId, i] = id.split(':');
    const d = this.drawn.get(flowId!);
    return d ? { kind: 'flow', def: d.def, flow: d.flow, stage: Number(i) } : null;
  }
}
