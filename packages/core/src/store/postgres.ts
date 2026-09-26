import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bucketsInRange, type Category, type Poi, type PoiLite } from '@way/shared';
import type { KeyRecord, KeyStatus, Store, StoredDoors, ViewQuery } from './types.ts';

/** Minimal query interface shared by node-postgres Pool and PGlite (tests). */
interface Conn {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface Queryable extends Conn {
  /** Pools hand out a dedicated connection (needed for transactions). */
  connect?(): Promise<Conn & { release(): void }>;
  end?(): Promise<void>;
  close?(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const POI_COLS = [
  'id', 'wikidata_qid', 'title', 'summary', 'summary_lang', 'description', 'category', 'tags',
  'date_start', 'date_end', 'date_precision', 'lat', 'lon', 'geo_precision', 'h3_cells',
  'importance', 'confidence', 'provenance', 'sources', 'image_url', 'wiki_title', 'wiki_lang', 'view_count',
] as const;

// Columns refreshed when a known entity is fetched again.
const UPDATABLE = [
  'title', 'description', 'category', 'date_start', 'date_end', 'date_precision', 'lat', 'lon',
  'h3_cells', 'importance', 'sources', 'wiki_title', 'wiki_lang',
];

const LITE_COLS = 'id, title, category, date_start, date_end, date_precision, lat, lon, importance, confidence';

/** Split a migration file into statements (PGlite's extended protocol takes one per query). */
function splitSql(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class PostgresStore implements Store {
  constructor(private db: Queryable) {}

  async init(): Promise<void> {
    const conn = this.db.connect ? await this.db.connect() : this.db;
    try {
      // API and worker may start together: serialize migrations.
      await conn.query('SELECT pg_advisory_lock(7462001)');
      await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Set((await conn.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
        if (done.has(file)) continue;
        await conn.query('BEGIN');
        try {
          for (const stmt of splitSql(readFileSync(MIGRATIONS_DIR + file, 'utf8'))) await conn.query(stmt);
          await conn.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await conn.query('COMMIT');
          console.log(`[db] applied migration ${file}`);
        } catch (e) {
          await conn.query('ROLLBACK');
          throw e;
        }
      }
      await conn.query('SELECT pg_advisory_unlock(7462001)');
    } finally {
      if ('release' in conn && typeof conn.release === 'function') conn.release();
    }
  }

  async close(): Promise<void> {
    await (this.db.end ?? this.db.close)?.call(this.db);
  }

  async upsertPois(pois: Poi[]): Promise<void> {
    for (let i = 0; i < pois.length; i += 200) {
      const chunk = pois.slice(i, i + 200);
      const params: unknown[] = [];
      const rows = chunk.map((p) => {
        const vals = POI_COLS.map((c) => (c === 'sources' ? JSON.stringify(p.sources) : p[c]));
        const ph = vals.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      await this.db.query(
        `INSERT INTO pois (${POI_COLS.join(', ')}) VALUES ${rows.join(', ')}
         ON CONFLICT (wikidata_qid) DO UPDATE SET ${UPDATABLE.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
           image_url = COALESCE(pois.image_url, EXCLUDED.image_url)`,
        params,
      );
    }
  }

  async existingQids(qids: string[]): Promise<Set<string>> {
    if (qids.length === 0) return new Set();
    const r = await this.db.query<{ wikidata_qid: string }>(
      'SELECT wikidata_qid FROM pois WHERE wikidata_qid = ANY($1::text[])', [qids],
    );
    return new Set(r.rows.map((x) => x.wikidata_qid));
  }

  async queryView(q: ViewQuery): Promise<PoiLite[]> {
    if (q.cells.length === 0) return [];
    const r = await this.db.query<PoiLite>(
      `SELECT ${LITE_COLS} FROM (
         SELECT ${LITE_COLS}, row_number() OVER (PARTITION BY h3_cells[$1] ORDER BY importance DESC) AS rn
         FROM pois
         WHERE h3_cells && $2::text[] AND date_start <= $4 AND COALESCE(date_end, date_start) >= $3
       ) t WHERE rn <= $5`,
      [q.res + 1, q.cells, q.tStart, q.tEnd, q.perCell],
    );
    return r.rows;
  }

  async getPoi(id: string): Promise<Poi | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.db.query<Poi>(`SELECT ${POI_COLS.join(', ')} FROM pois WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  async updatePoi(id: string, patch: Partial<Poi>): Promise<void> {
    const entries = Object.entries(patch);
    if (entries.length === 0) return;
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
    const vals = entries.map(([k, v]) => (k === 'sources' ? JSON.stringify(v) : v));
    await this.db.query(`UPDATE pois SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
  }

  async touchPoi(id: string): Promise<void> {
    await this.db.query('UPDATE pois SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1', [id]);
  }

  async getPoisByQids(qids: string[]): Promise<Poi[]> {
    if (qids.length === 0) return [];
    const r = await this.db.query<Poi>(`SELECT ${POI_COLS.join(', ')} FROM pois WHERE wikidata_qid = ANY($1::text[])`, [qids]);
    return r.rows;
  }

  async queryTimeRange(t0: number, t1: number, limit: number): Promise<PoiLite[]> {
    const r = await this.db.query<PoiLite>(
      `SELECT ${LITE_COLS} FROM pois WHERE date_start <= $2 AND COALESCE(date_end, date_start) >= $1
       ORDER BY importance DESC LIMIT $3`,
      [t0, t1, limit],
    );
    return r.rows;
  }

  async getDoors(id: string): Promise<StoredDoors | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.db.query<{ related: unknown }>('SELECT related FROM pois WHERE id = $1', [id]);
    const v = r.rows[0]?.related;
    // The column defaults to '[]': no doors computed yet.
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as StoredDoors) : null;
  }

  async setDoors(id: string, doors: StoredDoors): Promise<void> {
    await this.db.query('UPDATE pois SET related = $2 WHERE id = $1', [id, JSON.stringify(doors)]);
  }

  async getKeys(keys: string[]): Promise<Map<string, KeyRecord>> {
    if (keys.length === 0) return new Map();
    const r = await this.db.query<{ key: string; status: KeyStatus; fetched_at: Date | string }>(
      'SELECT key, status, fetched_at FROM search_keys WHERE key = ANY($1::text[])', [keys],
    );
    return new Map(r.rows.map((x) => [x.key, { status: x.status, updatedAt: new Date(x.fetched_at).getTime() }]));
  }

  async setKeys(keys: string[], status: KeyStatus, providers: string[] = []): Promise<void> {
    if (keys.length === 0) return;
    await this.db.query(
      `INSERT INTO search_keys (key, status, providers_used)
       SELECT k, $2, $3::text[] FROM unnest($1::text[]) AS k
       ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, fetched_at = now(),
         providers_used = EXCLUDED.providers_used`,
      [keys, status, providers],
    );
  }

  async keyStats(): Promise<Record<KeyStatus, number>> {
    const s: Record<KeyStatus, number> = { pending: 0, done: 0, partial: 0, failed: 0 };
    const r = await this.db.query<{ status: KeyStatus; n: string }>('SELECT status, count(*) AS n FROM search_keys GROUP BY status');
    for (const x of r.rows) s[x.status] = Number(x.n);
    return s;
  }

  async poiCount(): Promise<number> {
    const r = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM pois');
    return Number(r.rows[0]?.n ?? 0);
  }

  async cacheBytes(): Promise<number> {
    const r = await this.db.query<{ n: string | null }>(
      `SELECT (SELECT COALESCE(sum(pg_column_size(p.*)), 0) FROM pois p)
            + (SELECT COALESCE(sum(pg_column_size(k.*)), 0) FROM search_keys k) AS n`,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  async evict(count: number, pinImportance: number): Promise<number> {
    if (count <= 0) return 0;
    const gone = await this.db.query<{ h3_cells: string[]; date_start: number; date_end: number }>(
      `WITH victims AS (
         SELECT id FROM pois WHERE importance < $2
         ORDER BY view_count ASC, COALESCE(last_viewed_at, created_at) ASC, importance ASC
         LIMIT $1
       )
       DELETE FROM pois p USING victims v WHERE p.id = v.id
       RETURNING p.h3_cells, p.date_start, COALESCE(p.date_end, p.date_start) AS date_end`,
      [count, pinImportance],
    );
    await this.forgetKeys(gone.rows);
    return gone.rows.length;
  }

  /** Coarse but safe: re-searching an area only costs a provider query. */
  private async forgetKeys(rows: { h3_cells: string[]; date_start: number; date_end: number }[]): Promise<void> {
    if (rows.length === 0) return;
    const spaces = new Set<string>();
    const buckets = new Set<string>();
    for (const r of rows) {
      r.h3_cells.forEach((c) => spaces.add(c));
      bucketsInRange(r.date_start, r.date_end).forEach((b) => buckets.add(String(b)));
    }
    await this.db.query(
      `DELETE FROM search_keys WHERE split_part(key, '|', 1) = ANY($1::text[])
         OR (split_part(key, '|', 1) = 'g' AND split_part(key, '|', 2) = ANY($2::text[]))`,
      [[...spaces], [...buckets]],
    );
  }

  async getClassCategories(classes: string[]): Promise<Map<string, Category | null>> {
    if (classes.length === 0) return new Map();
    const r = await this.db.query<{ class: string; category: Category | null }>(
      'SELECT class, category FROM class_categories WHERE class = ANY($1::text[])', [classes],
    );
    return new Map(r.rows.map((x) => [x.class, x.category]));
  }

  async setClassCategories(map: Map<string, Category | null>): Promise<void> {
    if (map.size === 0) return;
    await this.db.query(
      `INSERT INTO class_categories (class, category)
       SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT (class) DO UPDATE SET category = EXCLUDED.category`,
      [[...map.keys()], [...map.values()]],
    );
  }
}
