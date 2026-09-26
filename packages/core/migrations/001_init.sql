-- POI cache (brief §6.1). Retrieval is by H3 cell membership: h3_cells holds
-- the POI's cell at resolutions 0..8, so h3_cells[res + 1] is its cell at `res`.
CREATE TABLE pois (
  id             uuid PRIMARY KEY,
  wikidata_qid   text UNIQUE,
  title          text NOT NULL,
  summary        text,
  summary_lang   text,
  description    text,
  category       text NOT NULL,
  tags           text[] NOT NULL DEFAULT '{}',
  date_start     integer NOT NULL,
  date_end       integer,
  date_precision text NOT NULL,
  lat            double precision NOT NULL,
  lon            double precision NOT NULL,
  geo_precision  text NOT NULL,
  h3_cells       text[] NOT NULL,
  importance     real NOT NULL,
  confidence     text NOT NULL,
  provenance     text NOT NULL,
  sources        jsonb NOT NULL,
  image_url      text,
  wiki_title     text,
  wiki_lang      text,
  related        jsonb NOT NULL DEFAULT '[]',
  view_count     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_viewed_at timestamptz
);
CREATE INDEX pois_h3_cells_gin ON pois USING gin (h3_cells);
CREATE INDEX pois_date_start ON pois (date_start);

-- Search coverage (brief §6.2): key = space|bucket|filter.
CREATE TABLE search_keys (
  key            text PRIMARY KEY,
  status         text NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  providers_used text[] NOT NULL DEFAULT '{}'
);

-- Cache of Wikidata class -> app category (null = no known category).
CREATE TABLE class_categories (
  class    text PRIMARY KEY,
  category text
);
